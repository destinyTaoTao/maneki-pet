import { describe, expect, it } from "vitest";

import {
  checkCapabilityConsistency,
  type CallContext,
  type HarnessAdapter,
} from "@maneki-pet/core";

import { DshAdapter } from "../src/index.js";

const ctx: CallContext = {
  requestId: "req-1",
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
};

describe("DshAdapter 观察适配器 v0（能力声明忠实于活体 spike）", () => {
  it("没有已验证的事件或执行能力", () => {
    const adapter = new DshAdapter();
    expect(adapter.capabilities).toEqual({
      events: false,
      newTask: false,
      continueSession: false,
      reply: false,
      query: "none",
      cancel: false,
      deduplicateSubmit: false,
      approval: "none",
      sessionOverview: false,
    });
    expect(adapter.dataBoundary).toEqual({
      processing: "unknown",
      destinations: [],
    });
  });

  it("构造时通过能力一致性校验", () => {
    expect(() => new DshAdapter()).not.toThrow();
  });

  it("discover 返回显式配置的会话列表；默认空列表", async () => {
    const configured = [{ sessionId: "session-1", workdir: "C:\\tmp\\proj" }];
    expect(await new DshAdapter({ sessions: configured }).discover(ctx)).toEqual(configured);
    expect(await new DshAdapter().discover(ctx)).toEqual([]);
  });

  it("没有事件源时订阅明确拒绝", async () => {
    const adapter = new DshAdapter();
    await expect(adapter.subscribe(() => undefined, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("一致性校验器：newTask 无 submit、bridge 无 decidePermission、approval 与派发脱节都要报", () => {
    const broken = {
      id: "broken",
      apiVersion: 1,
      dataBoundary: { processing: "local", destinations: [] },
      capabilities: {
        events: false,
        newTask: true,
        continueSession: false,
        reply: false,
        query: "none",
        cancel: false,
        deduplicateSubmit: false,
        approval: "bridge",
        sessionOverview: false,
      },
      discover: async () => [],
      subscribe: async () => () => undefined,
    } as unknown as HarnessAdapter;
    const problems = checkCapabilityConsistency(broken);
    expect(problems).toHaveLength(3);
    expect(problems).toContain("capability newTask requires method submit");
    expect(problems).toContain("capability approval=bridge requires method decidePermission");
    expect(problems).toContain("capability approval=bridge requires method queryOperation");
  });
});
