/**
 * Maneki CLI（扩展功能域命令）：发布就绪包竖切的用户可运行入口。
 * 红线：所有平台写动作都是人工；本 CLI 只备料、采集证据、格式化建议。
 * EverNook 侧操作经 Python shim 子进程（JSON stdin/stdout）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  DraftFlow,
  validateMetadataJson,
  validateOpsData,
  type DraftStep,
  type PublishDraft,
} from "@maneki-pet/platform-core";
import { BilibiliPlatformAdapter, MANUAL_PUBLISH_TOOL_NAME, PACKAGE_TOOL_NAME } from "@maneki-pet/platform-bilibili";

export interface ShimOptions {
  python: string;
  config: string;
  access: string;
  /** shim 模块调用方式：-m maneki_evernook_adapter（venv 内已安装）。 */
  shimModule?: string;
}

export interface ShimResult {
  ok: boolean;
  output: unknown;
  raw: string;
}

/** 调用 Python shim 子进程；密钥/令牌不经过本 CLI 的任何输出。 */
export function runShimCommand(shim: ShimOptions, command: string, args: string[], stdin?: unknown): ShimResult {
  const moduleArgs = ["-m", shim.shimModule ?? "maneki_evernook_adapter", command, "--config", shim.config, "--access", shim.access, ...args];
  const result = spawnSync(shim.python, moduleArgs, {
    input: stdin === undefined ? "" : JSON.stringify(stdin),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, output: { error: { code: "spawn-failed", message: result.error.message } }, raw: result.stderr ?? "" };
  }
  let output: unknown = null;
  try {
    output = JSON.parse(result.stdout ?? "{}");
  } catch {
    output = { error: { code: "shim-output-invalid", message: result.stdout ?? "(empty)" } };
  }
  const failed = result.status !== 0;
  const raw = (result.stdout ?? "") + (result.stderr && result.stderr.length > 0 ? `\n[stderr] ${result.stderr}` : "");
  return { ok: !failed, output, raw };
}

/** 从消息回执构造经验来源 EvidenceSpan JSON（竖切⑤：证据可作经验来源）。 */
export function buildExperienceSpan(
  shim: ShimOptions,
  message_id: string,
  start: number,
  end: number,
): ShimResult {
  return runShimCommand(shim, "experience-span", ["--message-id", message_id, "--start", String(start), "--end", String(end)]);
}

/** 交互式六步草稿（竖切②）：逐步输入+逐步显式确认；Ctrl+C 中止不产出。 */
export async function runDraftFlowInteractive(
  io: {
    question: (prompt: string) => Promise<string>;
    confirm: (prompt: string) => Promise<boolean>;
    print: (line: string) => void;
  },
  adapter: BilibiliPlatformAdapter,
  seed?: Partial<PublishDraft>,
): Promise<PublishDraft> {
  const flow = new DraftFlow({
    topic: seed?.topic ?? "",
    script: seed?.script ?? "",
    title: seed?.title ?? "",
    intro: seed?.intro ?? "",
    tags: seed?.tags ?? [],
    coverSuggestion: seed?.coverSuggestion ?? "",
  });
  const stepPrompts: Record<DraftStep, string> = {
    topic: "选题（一句话讲什么）",
    script: "脚本正文（口播稿）",
    title: "标题（≤80 字）",
    intro: "简介（≤2000 字）",
    tags: "标签（逗号分隔，1..10 个）",
    cover: "封面建议（构图要点；图片由你提供）",
  };
  while (!flow.complete) {
    process.stderr.write(`[trace] loop top, step=${String(flow.currentStep)}\n`);
    const step = flow.currentStep as DraftStep;
    const value = await io.question(`${stepPrompts[step]}：`);
    applyDraftField(flow.draft, step, value);
    const confirmed = await io.confirm(`确认「${step}」这一步？(y/N) `);
    if (!confirmed) {
      io.print(`已放弃「${step}」，请重新输入。`);
      continue;
    }
    flow.confirm(step);
    io.print(`✓ ${step} 已确认。`);
  }
  void adapter;
  return flow.draft;
}

export function applyDraftField(draft: PublishDraft, step: DraftStep, value: string): void {
  if (step === "tags") {
    draft.tags = value.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    return;
  }
  if (step === "cover") {
    draft.coverSuggestion = value;
    return;
  }
  draft[step] = value;
}

export interface ReceiptOutcome {
  userRequestMessageId: string;
  packageToolCallMessageId: string;
  publishReceiptMessageId: string;
  gaps: string[];
}

/** 竖切④：稿件信息回执采集链（输入 → tool_call → tool_result+元数据附件）。 */
export function capturePublishReceipt(
  shim: ShimOptions,
  input: { packageDir: string; bvid: string; userRequest: string; publishDate?: string },
): ReceiptOutcome {
  const metadataPath = input.packageDir ? joinPath(input.packageDir, "metadata.json") : "";
  if (!existsSync(metadataPath)) {
    throw new Error(`metadata.json missing in package dir: ${input.packageDir}`);
  }
  const metadataBytes = readFileSync(metadataPath);
  const metadataSha = createHash("sha256").update(metadataBytes).digest("hex");
  const checked = validateMetadataJson(JSON.parse(metadataBytes.toString("utf8")), "bilibili");
  if (!checked.ok) {
    throw new Error(`metadata.json failed contract validation: ${checked.reason}`);
  }

  const occurred = new Date().toISOString();
  const requestReceipt = runShimCommand(shim, "capture-message", [], {
    source: { entry: "maneki", session: "platform-bilibili", branch: "main", event: `u-${Date.now()}` },
    role: "user",
    sequence: 1,
    occurred_at: occurred,
    completion: "complete",
    text: input.userRequest,
  });
  if (!requestReceipt.ok) throw new Error(`user input capture failed: ${requestReceipt.raw}`);
  const inputId = (requestReceipt.output as { message_id: string }).message_id;

  const callReceipt = runShimCommand(shim, "capture-tool", ["--kind", "tool_call", "--tool-name", PACKAGE_TOOL_NAME, "--input-id", inputId], {
    event: { source: { entry: "maneki", session: "platform-bilibili", branch: "main", event: `t-${Date.now()}` }, role: "assistant", sequence: 2, occurred_at: occurred, completion: "complete", text: "生成发布就绪包：视频+封面+元数据 JSON+分步指引。" },
  });
  if (!callReceipt.ok) throw new Error(`tool_call capture failed: ${callReceipt.raw}`);
  const callMessageId = (callReceipt.output as { message_id: string }).message_id;

  const resultReceipt = runShimCommand(shim, "capture-tool", ["--kind", "tool_result", "--tool-name", MANUAL_PUBLISH_TOOL_NAME, "--input-id", inputId], {
    event: { source: { entry: "maneki", session: "platform-bilibili", branch: "main", event: `t-${Date.now() + 1}` }, role: "assistant", sequence: 3, occurred_at: new Date().toISOString(), completion: "complete", text: `用户已在 B站创作中心完成人工发布（${input.bvid}${input.publishDate ? `，${input.publishDate}` : ""}）；稿件信息经显式人工确认入口采集。` },
    attachments: [{ attachment_id: "metadata", label: "metadata.json", mime_type: "application/json", bytes: metadataBytes.toString("utf8") }],
  });
  if (!resultReceipt.ok) throw new Error(`tool_result capture failed: ${resultReceipt.raw}`);
  const output = resultReceipt.output as { message_id: string; gaps?: string[] };
  void metadataSha;
  return {
    userRequestMessageId: inputId,
    packageToolCallMessageId: callMessageId,
    publishReceiptMessageId: output.message_id,
    gaps: output.gaps ?? [],
  };
}

/** 竖切④续：运营数据模板解析 + tool_result 采集（标注 manual-export 人工来源）。 */
export function captureOpsData(
  shim: ShimOptions,
  input: { opsFile: string; inputId: string },
): { videoId: string; date: string; messageId: string } {
  const raw = readFileSync(input.opsFile, "utf8");
  const checked = validateOpsData(JSON.parse(raw), "bilibili");
  if (!checked.ok) {
    throw new Error(`ops data failed contract validation: ${checked.reason}`);
  }
  const receipt = runShimCommand(shim, "capture-tool", ["--kind", "tool_result", "--tool-name", "manual-ops-data-bilibili", "--input-id", input.inputId], {
    event: { source: { entry: "maneki", session: "platform-bilibili", branch: "main", event: `o-${Date.now()}` }, role: "assistant", sequence: 4, occurred_at: new Date().toISOString(), completion: "complete", text: `运营数据（人工导出，source=manual-export）：${input.opsFile}` },
  });
  if (!receipt.ok) throw new Error(`ops capture failed: ${receipt.raw}`);
  const output = receipt.output as { message_id: string };
  return { videoId: checked.value.videoId, date: checked.value.date, messageId: output.message_id };
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}
