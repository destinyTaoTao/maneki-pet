/**
 * B站平台对接器（architecture §10.2 范本实现）。
 * 合规红线：只做"AI 备料 + 人工发布 + 证据回流"——不集成 biliup/协议模拟/
 * UI 自动化；发布/删除类写操作逐次确认；对外互动只做汇总+建议草稿。
 * 人工发布入口（native route）：B站创作中心 https://member.bilibili.com/platform/upload/video/frame
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateMetadataJson,
  validateOpsData,
  type PlatformCapabilities,
  type PlatformCapability,
  type PublishDraft,
  type PublishMetadata,
} from "@maneki-pet/platform-core";

export const BILIBILI_CAPABILITIES: readonly PlatformCapability[] = [
  "draft",
  "package_export",
  "receipt_capture",
  "ops_data_parsing",
];

export const MANUAL_PUBLISH_ROUTE = "https://member.bilibili.com/platform/upload/video/frame";
/** 人工发布回执的稳定工具名（EverNook spec 增量节指定）。 */
export const MANUAL_PUBLISH_TOOL_NAME = "manual-publish-bilibili";
/** 发布就绪包生成步骤的稳定工具名（回执关联输入用）。 */
export const PACKAGE_TOOL_NAME = "generate-publish-ready-package";

export interface BilibiliPlatformAdapterOptions {
  fetchImpl?: typeof fetch;
}

export function bilibiliCapabilities(): PlatformCapabilities {
  return { capabilities: BILIBILI_CAPABILITIES, manualPublishRoute: MANUAL_PUBLISH_ROUTE };
}

export function sha256File(path: string): { bytes: number; sha256: string } {
  const content = readFileSync(path);
  return {
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export interface ExportPackageInput {
  /** 输出目录（发布就绪包落地处；必须不存在或为空目录）。 */
  outDir: string;
  /** 用户提供的成片与封面（大资产，仅复制与哈希，不进 EverNook 账本）。 */
  videoSource: string;
  coverSource: string;
  /** 六步全部确认的草稿（未确认完整即拒绝——竖切②门控）。 */
  flow: { complete: boolean; draft: PublishDraft };
  /** 可选：技能包经验回链（写进元数据 JSON）。 */
  experienceId?: string;
  now?: () => Date;
}

export interface ExportPackageResult {
  packageDir: string;
  metadataPath: string;
  guidePath: string;
  metadata: PublishMetadata;
}

export class BilibiliPlatformAdapter {
  readonly id = "bilibili";
  readonly capabilities: PlatformCapabilities = bilibiliCapabilities();

  constructor(_options: BilibiliPlatformAdapterOptions = {}) {}

  /** 发布就绪包导出（竖切③）：六步确认完成后方可执行；产物四件套落盘。 */
  exportPackage(input: ExportPackageInput): ExportPackageResult {
    if (!input.flow.complete) {
      throw new Error("publish draft is not fully confirmed: six-step confirmation required before export");
    }
    if (!existsSync(input.videoSource)) {
      throw new Error(`video source missing: ${input.videoSource}`);
    }
    if (!existsSync(input.coverSource)) {
      throw new Error(`cover source missing: ${input.coverSource}`);
    }
    if (existsSync(input.outDir)) {
      throw new Error(`out dir already exists: ${input.outDir}`);
    }
    const video = sha256File(input.videoSource);
    const cover = sha256File(input.coverSource);
    const now = (input.now ?? (() => new Date()))().toISOString();
    const metadata: PublishMetadata = {
      schemaVersion: 1,
      platform: this.id,
      title: input.flow.draft.title,
      intro: input.flow.draft.intro,
      tags: input.flow.draft.tags,
      video: {
        file: join("video", input.videoSource.split(/[\\/]/).pop() ?? "video.mp4"),
        bytes: video.bytes,
        sha256: video.sha256,
      },
      cover: {
        file: join("cover", input.coverSource.split(/[\\/]/).pop() ?? "cover.png"),
        bytes: cover.bytes,
        sha256: cover.sha256,
      },
      ...(input.experienceId !== undefined ? { experienceId: input.experienceId } : {}),
      createdAt: now,
    };
    const checked = validateMetadataJson(
      {
        ...metadata,
        video: { ...metadata.video, file: join(input.outDir, metadata.video.file) },
        cover: { ...metadata.cover, file: join(input.outDir, metadata.cover.file) },
      },
      this.id,
    );
    if (!checked.ok) {
      throw new Error(`generated metadata failed contract validation: ${checked.reason}`);
    }

    mkdirSync(join(input.outDir, "video"), { recursive: true });
    mkdirSync(join(input.outDir, "cover"), { recursive: true });
    copyFileSync(input.videoSource, join(input.outDir, metadata.video.file));
    copyFileSync(input.coverSource, join(input.outDir, metadata.cover.file));
    const metadataPath = join(input.outDir, "metadata.json");
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    const guidePath = join(input.outDir, "PUBLISH-GUIDE.md");
    writeFileSync(guidePath, publishGuide(metadata), "utf8");

    const metadataPathVerified = join(input.outDir, "metadata.json");
    const parsedMeta = JSON.parse(readFileSync(metadataPathVerified, "utf8")) as PublishMetadata;
    const revalidated = validateMetadataJson(
      {
        ...parsedMeta,
        video: { ...parsedMeta.video, file: join(input.outDir, parsedMeta.video.file) },
        cover: { ...parsedMeta.cover, file: join(input.outDir, parsedMeta.cover.file) },
      },
      this.id,
    );
    if (!revalidated.ok) {
      throw new Error(`metadata.json failed revalidation: ${revalidated.reason}`);
    }
    return { packageDir: input.outDir, metadataPath: metadataPathVerified, guidePath, metadata };
  }

  /** 运营数据人工导出解析：只接受 manual-export 来源（模板契约）。 */
  parseOpsData(raw: string): ReturnType<typeof validateOpsData> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: `ops data is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    return validateOpsData(parsed, this.id);
  }
}

/** 分步发布指引：人工在 B站创作中心完成的每一步，含红线提示与回执采集命令。 */
function publishGuide(metadata: PublishMetadata): string {
  return [
    "# B站发布指引（人工发布，AI 仅备料）",
    "",
    "本包由 Maneki 备料生成。按以下步骤在 B站创作中心**人工发布**；任何平台写操作都不由 AI 代做。",
    "",
    "## 步骤",
    "",
    `1. 打开 B站创作中心视频投稿页：<${MANUAL_PUBLISH_ROUTE}>`,
    `2. 上传视频文件：本包 \`${metadata.video.file}\`（${metadata.video.bytes} 字节，sha256=${metadata.video.sha256.slice(0, 16)}…）`,
    `3. 标题（照抄）：${metadata.title}`,
    `4. 简介（照抄）：${metadata.intro}`,
    `5. 标签（逐个添加）：${metadata.tags.join("、")}`,
    `6. 封面：上传本包 \`${metadata.cover.file}\``,
    "7. 检查无定时发布、无自动参与活动等附加选项后，**人工点击投稿**。",
    "",
    "## 发布后：回执采集（竖切④）",
    "",
    "在稿件管理页复制稿件信息（BVID/标题/发布时间），然后运行：",
    "",
    "```",
    "maneki platform receipt --package <本包目录> --bvid <稿件BVID> \\",
    "  --user-request \"<当初让你生成这个包的原始请求>\"",
    "```",
    "",
    "回执将以 tool_result 事件（tool_name=manual-publish-bilibili）连同元数据 JSON 附件进入 EverNook 证据账本，",
    "关联到生成发布就绪包的 tool_call 事件；后续可作为经验草案来源（人工确认后）。",
    "",
    "## 运营数据",
    "",
    "日后从创作中心数据中心**人工导出/复制**播放/点赞/评论/收藏/投币/分享数据，",
    "按 `bilibili-ops-data.v1` 模板（source=manual-export）提交采集。不做任何平台自动化抓取。",
    "",
    `生成时间：${metadata.createdAt} · 元数据 schemaVersion：${metadata.schemaVersion}`,
    "",
  ].join("\n");
}
