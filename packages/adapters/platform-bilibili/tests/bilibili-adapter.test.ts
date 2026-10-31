import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DraftFlow } from "@maneki-pet/platform-core";

import {
  BilibiliPlatformAdapter,
  MANUAL_PUBLISH_TOOL_NAME,
  bilibiliCapabilities,
} from "../src/index.js";

const draft = {
  topic: "发布经验讲清楚",
  script: "开场结论先行……",
  title: "如何让 AI 备料、人工发布",
  intro: "本期讲发布就绪包工作流。",
  tags: ["ai", "工作流"],
  coverSuggestion: "大字标题+小招形象居中",
};

function confirmedFlow(): DraftFlow {
  const flow = new DraftFlow(draft);
  for (const step of ["topic", "script", "title", "intro", "tags", "cover"] as const) {
    flow.confirm(step);
  }
  return flow;
}

function makeAsset(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(): string {
  const dir = join(tmpdir(), `maneki-bili-${Math.random().toString(36).slice(2)}`);
  cleanupDirs.push(dir);
  return dir;
}

describe("BilibiliPlatformAdapter", () => {
  it("能力枚举符合合规红线（无发送类能力；人工发布入口为创作中心）", () => {
    const capabilities = bilibiliCapabilities();
    expect(capabilities.capabilities).toEqual([
      "draft",
      "package_export",
      "receipt_capture",
      "ops_data_parsing",
    ]);
    expect(capabilities.manualPublishRoute).toContain("member.bilibili.com");
  });

  it("六步未确认完成前导出被拒绝（竖切②门控）", () => {
    const adapter = new BilibiliPlatformAdapter();
    const outDir = makeTemp();
    const video = makeAsset(makeTemp(), "final.mp4", "video-bytes");
    const cover = makeAsset(makeTemp(), "cover.png", "png-bytes");
    const partial = new DraftFlow(draft);
    partial.confirm("topic");
    expect(() => adapter.exportPackage({ outDir, videoSource: video, coverSource: cover, flow: partial })).toThrow(
      /six-step confirmation required/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("导出发布就绪包：四件套落盘、元数据过契约校验、指引含回执步骤（竖切③）", () => {
    const adapter = new BilibiliPlatformAdapter();
    const outDir = join(makeTemp(), "package");
    const videoContent = "fake-mp4-bytes";
    const video = makeAsset(makeTemp(), "final.mp4", videoContent);
    const cover = makeAsset(makeTemp(), "cover.png", "png-bytes");

    const result = adapter.exportPackage({
      outDir,
      videoSource: video,
      coverSource: cover,
      flow: confirmedFlow(),
      experienceId: "9f34fd12-9172-44a6-8ebd-5913c872571e",
    });

    expect(existsSync(join(outDir, "video", "final.mp4"))).toBe(true);
    expect(readFileSync(join(outDir, "video", "final.mp4"), "utf8")).toBe(videoContent);
    expect(existsSync(join(outDir, "cover", "cover.png"))).toBe(true);

    const metadata = JSON.parse(readFileSync(result.metadataPath, "utf8"));
    expect(metadata.platform).toBe("bilibili");
    expect(metadata.title).toBe(draft.title);
    expect(metadata.video.sha256).toBe(createHash("sha256").update(videoContent).digest("hex"));
    expect(metadata.experienceId).toBe("9f34fd12-9172-44a6-8ebd-5913c872571e");

    const guide = readFileSync(result.guidePath, "utf8");
    expect(guide).toContain("member.bilibili.com");
    expect(guide).toContain(MANUAL_PUBLISH_TOOL_NAME);
    expect(guide).toContain("人工点击投稿");
  });

  it("输出目录已存在时拒绝（防覆盖既有备料）", () => {
    const adapter = new BilibiliPlatformAdapter();
    const outDir = makeTemp();
    mkdirSync(outDir, { recursive: true });
    const video = makeAsset(makeTemp(), "final.mp4", "v");
    const cover = makeAsset(makeTemp(), "cover.png", "c");
    expect(() =>
      adapter.exportPackage({ outDir, videoSource: video, coverSource: cover, flow: confirmedFlow() }),
    ).toThrow(/already exists/);
  });

  it("运营数据解析：模板通过、人工来源强制、坏 JSON 拒绝", () => {
    const adapter = new BilibiliPlatformAdapter();
    const good = adapter.parseOpsData(
      '{"schemaVersion":1,"platform":"bilibili","videoId":"BV1xx411c7mD","date":"2026-11-07","plays":10,"likes":2,"comments":1,"coins":0,"shares":0,"source":"manual-export"}',
    );
    expect(good.ok).toBe(true);
    expect(adapter.parseOpsData("not-json").ok).toBe(false);
    expect(
      adapter.parseOpsData(
        '{"schemaVersion":1,"platform":"bilibili","videoId":"BV1","date":"2026-11-07","plays":1,"likes":1,"comments":1,"coins":1,"shares":1,"source":"bot"}',
      ).ok,
    ).toBe(false);
  });
});
