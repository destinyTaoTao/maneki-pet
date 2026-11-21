import { afterEach, expect, it, vi } from "vitest";
import { SessionObservations } from "../src/session-observations.js";

const sourceId = "00000000-0000-4000-8000-000000000001";
const rows = (phase = "waiting_input", sequence = 1) => [
  { sessionId: "session-A", projectName: "project-A", phase, sequence, observedAt: 1000 },
  { sessionId: "session-B", projectName: "project-B", phase: "completed", sequence: 3, observedAt: 1000 },
];
const report = (reportSequence = 1, sessions = rows()) => ({ sourceId, reportSequence, profileId: "web", connected: true, truncated: false, sessions });
const feeds: SessionObservations[] = [];
afterEach(() => { for (const feed of feeds.splice(0)) feed.close(); vi.useRealTimers(); });
function setup() {
  let now = 1000;
  const active = new Set(["owner", "other"]);
  const publish = vi.fn();
  const feed = new SessionObservations({ active: (client) => active.has(client), publish, now: () => now });
  feeds.push(feed);
  return { feed, active, publish, advance: (ms: number) => { now += ms; } };
}

it("A 等待与 B 完成分别保留，完整 ID 和项目目录名可定位", () => {
  const { feed } = setup();
  feed.report("owner", report());
  const source = feed.snapshot()[0]!;
  expect(source.connected).toBe(true);
  expect(source.sessions.map((row) => [row.sessionId, row.phase])).toEqual([["session-A", "waiting_input"], ["session-B", "completed"]]);
  expect(source.sessions[0]!.projectName).toBe("project-A");
});

it("失联保留最后事实，重复报告不续租，新报告可恢复", () => {
  const { feed, advance } = setup();
  feed.report("owner", report());
  advance(14000);
  feed.report("owner", report());
  advance(1001);
  expect(feed.snapshot()[0]!.connected).toBe(false);
  expect(feed.snapshot()[0]!.sessions[0]!.phase).toBe("waiting_input");
  feed.report("owner", report(2));
  expect(feed.snapshot()[0]!.connected).toBe(true);
});

it("倒退或同序号变更整批拒绝，来源相同的不同客户端仍隔离", () => {
  const { feed } = setup();
  feed.report("owner", report());
  expect(() => feed.report("owner", report(2, rows("working")))).toThrow();
  expect(feed.snapshot()[0]!.sessions[0]!.phase).toBe("waiting_input");
  feed.report("other", report(1, rows("failed")));
  expect(feed.snapshot()).toHaveLength(2);
});

it("显式离线和凭证撤销均失联，超量和正文等未知字段不进入快照", () => {
  const { feed, active } = setup();
  expect(() => feed.report("owner", { ...report(), prompt: "private" })).toThrow();
  expect(() => feed.report("owner", report(1, Array.from({ length: 65 }, (_, i) => ({ ...rows()[0]!, sessionId: `session-${i}` }))))).toThrow();
  feed.report("owner", report());
  feed.report("owner", { ...report(2), connected: false });
  expect(feed.snapshot()[0]!.connected).toBe(false);
  feed.report("owner", report(3));
  active.delete("owner");
  expect(feed.snapshot()[0]!.connected).toBe(false);
});

it("来源满额时拒绝新增在线来源，过期后只回收失联来源", () => {
  const { feed, advance } = setup();
  const source = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  for (let index = 0; index < 64; index++) feed.report("owner", { ...report(), sourceId: source(index) });
  expect(() => feed.report("owner", { ...report(), sourceId: source(64) })).toThrow("observation_source_limit");
  expect(feed.snapshot()).toHaveLength(64);
  advance(15001);
  feed.report("owner", { ...report(), sourceId: source(64) });
  expect(feed.snapshot()).toHaveLength(64);
  expect(feed.snapshot().filter((item) => item.connected).map((item) => item.sourceId)).toEqual([source(64)]);
});

it("简报保留同来源 ID 的不同上报方，区分空闲、未观测、撤销和租约届满，读取不发布事件", () => {
  const { feed, advance, active, publish } = setup();
  const empty = { waiting: [], onlineSources: 0, offlineSources: 0, partialSessions: false };
  expect(feed.briefing()).toEqual(empty);
  feed.report("owner", report(1, rows("working")));
  expect(feed.briefing()).toEqual({ ...empty, onlineSources: 1 });
  feed.report("owner", { ...report(2, rows("waiting_input", 2)), truncated: true });
  feed.report("other", report());
  const both = feed.briefing();
  expect(both).toMatchObject({ onlineSources: 2, offlineSources: 0, partialSessions: true });
  expect(both.waiting.map(row => [row.clientId, row.sourceId, row.sessionId])).toEqual([
    ["owner", sourceId, "session-A"], ["other", sourceId, "session-A"],
  ]);
  publish.mockClear();
  active.delete("owner");
  expect(feed.briefing()).toMatchObject({ onlineSources: 1, offlineSources: 1, partialSessions: false, waiting: [{ clientId: "other" }] });
  advance(15000);
  expect(feed.briefing()).toEqual({ ...empty, offlineSources: 2 });
  expect(publish).not.toHaveBeenCalled();
});

it("跨来源仅取最近八条等待观测，截断只取决于在线数据", () => {
  const { feed } = setup();
  const sessions = Array.from({ length: 8 }, (_, i) => ({
    ...rows()[0]!, sessionId: `session-${i}`, observedAt: i + 1,
  }));
  feed.report("owner", report(1, sessions));
  expect(feed.briefing().partialSessions).toBe(false);
  feed.report("other", report(1, [{ ...sessions[0]!, observedAt: 9 }]));
  const result = feed.briefing();
  expect(result.waiting.map(row => row.observedAt)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  expect(result.partialSessions).toBe(true);
  feed.report("other", { ...report(2, []), connected: false, truncated: true });
  expect(feed.briefing()).toMatchObject({ partialSessions: false, onlineSources: 1, offlineSources: 1 });
});
