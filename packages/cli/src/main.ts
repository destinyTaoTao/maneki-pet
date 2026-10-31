/** Maneki CLI 入口：`maneki <command> …`（扩展功能域竖切命令）。 */
import { parseArgs } from "node:util";

import type { DraftStep } from "@maneki-pet/platform-core";
import { DraftFlow } from "@maneki-pet/platform-core";
import { applyDraftField } from "./platform-commands.js";

import {
  buildExperienceSpan,
  captureOpsData,
  capturePublishReceipt,
  runDraftFlowInteractive,
  type ShimOptions,
} from "./platform-commands.js";
import { BilibiliPlatformAdapter } from "@maneki-pet/platform-bilibili";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    python: { type: "string", default: "python" },
    config: { type: "string" },
    access: { type: "string" },
    "experience-ids": { type: "string", default: "" },
    draft: { type: "string" },
    "draft-input": { type: "string" },
    video: { type: "string" },
    cover: { type: "string" },
    out: { type: "string" },
    package: { type: "string" },
    bvid: { type: "string" },
    "user-request": { type: "string" },
    "ops-file": { type: "string" },
    "input-id": { type: "string" },
    "message-id": { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
  },
});

const command = positionals[0];
const shim: ShimOptions = {
  python: values.python ?? "python",
  config: values.config ?? "",
  access: values.access ?? "",
};

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    process.stderr.write(`missing required --${label}\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  switch (command) {
    case "platform": {
      const sub = positionals[1];
      const adapter = new BilibiliPlatformAdapter();
      if (sub === "draft" && values["draft-input"]) {
        // 文件模式：{steps:[{step,value}...]}，每条记录 = 该步内容 + 显式用户确认（逐次，按序）。
        const fs = await import("node:fs");
        const parsed = JSON.parse(fs.readFileSync(requireValue(values["draft-input"], "draft-input"), "utf8")) as {
          steps: Array<{ step: DraftStep; value: string }>;
        };
        const flow = new DraftFlow({
          topic: "",
          script: "",
          title: "",
          intro: "",
          tags: [],
          coverSuggestion: "",
        });
        const records: Array<{ step: DraftStep; confirmedAt: string }> = [];
        for (const entry of parsed.steps) {
          applyDraftField(flow.draft, entry.step, entry.value);
          records.push(flow.confirm(entry.step));
        }
        const outcomes = { draft: flow.draft, confirmations: records };
        process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
        return;
      }
      if (sub === "draft") {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin });
        const draft = await runDraftFlowInteractive(
          {
            question: (prompt) => rl.question(prompt),
            confirm: async (prompt) => (await rl.question(prompt)).trim().toLowerCase() === "y",
            print: (line) => process.stderr.write(`${line}
`),
          },
          adapter,
        );
        rl.close();
        process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);
        return;
      }
      if (sub === "package") {
        const draftFile = requireValue(values.draft, "draft");
        const adapter2 = new BilibiliPlatformAdapter();
        const parsedDraftFile = JSON.parse(
          (await import("node:fs")).readFileSync(draftFile, "utf8"),
        ) as { draft: Parameters<typeof adapter2.exportPackage>[0]["flow"]["draft"] };
        const flow = { complete: true, draft: parsedDraftFile.draft };
        process.stderr.write(`[trace] package: title=${JSON.stringify(parsedDraftFile.draft?.title)}\n`);
        const result = adapter2.exportPackage({
          outDir: requireValue(values.out, "out"),
          videoSource: requireValue(values.video, "video"),
          coverSource: requireValue(values.cover, "cover"),
          flow,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (sub === "receipt") {
        const outcome = capturePublishReceipt(shim, {
          packageDir: requireValue(values.package, "package"),
          bvid: requireValue(values.bvid, "bvid"),
          userRequest: requireValue(values["user-request"], "user-request"),
        });
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        return;
      }
      if (sub === "ops-import") {
        const outcome = captureOpsData(shim, {
          opsFile: requireValue(values["ops-file"], "ops-file"),
          inputId: requireValue(values["input-id"], "input-id"),
        });
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        return;
      }
      process.stderr.write(`unknown platform subcommand: ${String(sub)}\n`);
      process.exit(2);
      return;
    }
    case "experience-span": {
      const outcome = buildExperienceSpan(
        shim,
        requireValue(values["message-id"], "message-id"),
        Number(requireValue(values.start, "start")),
        Number(requireValue(values.end, "end")),
      );
      process.stdout.write(`${JSON.stringify(outcome.output, null, 2)}\n`);
      if (!outcome.ok) process.exit(1);
      return;
    }
    default:
      process.stderr.write("usage: maneki platform draft|package|receipt|ops-import | experience-span\n");
      process.exit(2);
  }
}

void main();
