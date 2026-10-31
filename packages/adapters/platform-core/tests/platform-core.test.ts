import { describe, expect, it } from "vitest";

import {
  DraftFlow,
  validateMetadataJson,
  validateOpsData,
} from "../src/index.js";

describe("DraftFlow 草稿逐次确认门控", () => {
  const draft = {
    topic: "把发布经验讲清楚",
    script: "开场 15 秒结论先行……",
    title: "如何让 AI 备料、人工发布",
    intro: "本期讲 Maneki 的发布就绪包工作流。",
    tags: ["ai", "工作流"],
    coverSuggestion: "大字标题+小招形象居中",
  };

  it("只能按顺序逐步确认；跳步与重复拒绝", () => {
    const flow = new DraftFlow(draft);
    expect(() => flow.confirm("script")).toThrow(/out of order/);
    expect(flow.confirm("topic").step).toBe("topic");
    expect(() => flow.confirm("topic")).toThrow(/out of order/);
    expect(flow.currentStep).toBe("script");
    for (const step of ["script", "title", "intro", "tags", "cover"] as const) {
      flow.confirm(step);
    }
    expect(flow.complete).toBe(true);
    expect(() => flow.confirm("cover")).toThrow(/fully confirmed/);
  });

  it("确认记录带时间戳，供审计", () => {
    const flow = new DraftFlow(draft, () => new Date("2026-10-31T15:00:00Z"));
    flow.confirm("topic");
    expect(flow.confirmedSteps[0]?.confirmedAt).toBe("2026-10-31T15:00:00.000Z");
  });
});

describe("发布元数据 JSON 契约", () => {
  const metadata = {
    schemaVersion: 1,
    platform: "bilibili",
    title: "如何让 AI 备料、人工发布",
    intro: "本期讲发布就绪包工作流。",
    tags: ["ai", "工作流"],
    video: { file: "video/final.mp4", bytes: 1024, sha256: "a".repeat(64), durationSeconds: 201 },
    cover: { file: "cover/cover.png", bytes: 512, sha256: "b".repeat(64) },
    experienceId: "9f34fd12-9172-44a6-8ebd-5913c872571e",
    createdAt: "2026-10-31T15:00:00Z",
  };

  it("合法元数据通过", () => {
    expect(validateMetadataJson(metadata, "bilibili").ok).toBe(true);
  });

  it("标题超 B站 80 字限制拒绝；未知字段拒绝；平台不符拒绝", () => {
    expect(validateMetadataJson({ ...metadata, title: "长".repeat(81) }, "bilibili").ok).toBe(false);
    expect(validateMetadataJson({ ...metadata, extra: 1 }, "bilibili").ok).toBe(false);
    expect(validateMetadataJson(metadata, "douyin").ok).toBe(false);
  });

  it("视频/封面引用必须带合法哈希", () => {
    const broken = { ...metadata, video: { ...metadata.video, sha256: "nope" } };
    expect(validateMetadataJson(broken, "bilibili").ok).toBe(false);
  });
});

describe("运营数据模板契约（人工导出标注）", () => {
  const ops = {
    schemaVersion: 1,
    platform: "bilibili",
    videoId: "BV1xx411c7mD",
    date: "2026-11-07",
    plays: 1200,
    likes: 88,
    comments: 12,
    coins: 30,
    shares: 5,
    source: "manual-export",
  };

  it("合法人工导出数据通过", () => {
    expect(validateOpsData(ops, "bilibili")).toEqual({ ok: true, value: ops });
  });

  it("source 必须标注 manual-export（防抓取自动来源混入）", () => {
    expect(validateOpsData({ ...ops, source: "scraped" }, "bilibili").ok).toBe(false);
  });

  it("计数必须为非负整数；日期必须 YYYY-MM-DD", () => {
    expect(validateOpsData({ ...ops, plays: -1 }, "bilibili").ok).toBe(false);
    expect(validateOpsData({ ...ops, date: "2026/11/07" }, "bilibili").ok).toBe(false);
  });
});
