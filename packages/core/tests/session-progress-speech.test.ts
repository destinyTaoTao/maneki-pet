import { expect, it } from "vitest";
import { sessionProgressReply, type SessionObservationSource } from "../src/session-observation.js";

it("简短进度查询和识别出的繁体写法复用同一观察事实，不猜测其他意图", () => {
  const sources: SessionObservationSource[] = [{
    clientId: "client", sourceId: "source", profileId: "test", connected: true,
    truncated: false, lastSeenAt: 1,
    sessions: [
      { sessionId: "A", projectName: "project-a", phase: "waiting_input", sequence: 1, observedAt: 1 },
      { sessionId: "B", projectName: "project-b", phase: "completed", sequence: 1, observedAt: 1 },
    ],
  }];
  const all = sessionProgressReply("查看会话进度", sources);
  expect(all).toContain("A：等待你回应");
  expect(all).toContain("B：已完成");
  for (const text of ["查看进度", "查看進度", "查看會話進度", "查看會話"]) {
    expect(sessionProgressReply(text, sources)).toBe(all);
  }
  const waiting = sessionProgressReply("哪个会话在等我", sources);
  expect(waiting).toContain("A：等待你回应");
  expect(waiting).not.toContain("B：已完成");
  expect(sessionProgressReply("哪個會話在等我？", sources)).toBe(waiting);
  expect(sessionProgressReply("查看绘画进度", sources)).toBeNull();
  expect(sessionProgressReply("请帮我删除会话", sources)).toBeNull();
});
