import { describe, expect, it } from "vitest";

import {
  checkCapabilityConsistency,
  type CallContext,
  type HarnessAdapter,
} from "@maneki-pet/core";

import { DshAdapter, type DshSessionEvent } from "../src/index.js";

const ctx: CallContext = {
  requestId: "req-1",
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
};

describe("DshAdapter 观察适配器 v0（能力声明忠实于活体 spike）", () => {
  it("重复与迟到事件不能重开终态，下一个 turn 仍可观察", async () => {
    let receive: (entry: DshSessionEvent) => void = () => undefined;
    const adapter = new DshAdapter({ eventSource: { subscribe: (listener) => { receive = listener; return () => undefined; } } });
    const events: unknown[] = [];
    const stop = await adapter.subscribe((event) => events.push(event.payload), ctx);
    receive({ sessionId: "s", event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
    receive({ sessionId: "s", event: { seq: 2, type: "step/start", data: { turn: 1 } } });
    receive({ sessionId: "s", event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
    receive({ sessionId: "s", event: { seq: 4, type: "step/start", data: { turn: 1 } } });
    receive({ sessionId: "s", event: { seq: 5, type: "turn/start", data: { turn: 2 } } });
    expect(events).toEqual([{ type: "task.completed" }, { type: "task.started" }]);
    stop();
  });

  it("取消观察后立即停止回调，过期调用和缺失 turn 身份不能生成任务事件", async () => {
    const controller = new AbortController();
    let receive: (entry: DshSessionEvent) => void = () => undefined;
    const adapter = new DshAdapter({ eventSource: { subscribe: (listener) => { receive = listener; return () => undefined; } } });
    const events: unknown[] = [];
    await adapter.subscribe((event) => events.push(event), { ...ctx, signal: controller.signal });
    receive({ sessionId: "s", event: { seq: 0, type: "turn/start", data: {} } });
    expect(events).toEqual([]);
    controller.abort();
    receive({ sessionId: "s", event: { seq: 1, type: "turn/start", data: { turn: 1 } } });
    expect(events).toEqual([]);
    await expect(adapter.subscribe(() => undefined, { ...ctx, deadlineAtMs: 0 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("思考、工具与原生审批等待分别表达，失败和取消不会变成成功；不转发原文", async () => {
    let receive: (entry: DshSessionEvent) => void = () => undefined;
    const adapter = new DshAdapter({ eventSource: { subscribe: (listener) => { receive = listener; return () => undefined; } } });
    const events: Array<{ payload: unknown }> = [];
    const stop = await adapter.subscribe((event) => events.push(event), ctx);
    const entries = [
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "tool/call", data: { turn: 1, name: "pwsh", arguments: "private command" } },
      { type: "tool/call", data: { turn: 1, name: "ask_user_question", arguments: "private question" } },
      { type: "approval/asked", data: { id: "a1", reason: "private reason" } },
      { type: "approval/decided", data: { id: "a1", outcome: "rejected" } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "private error" } } } },
      { type: "turn/end", data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } } },
      { type: "turn/end", data: { turn: 3, reason: { kind: "blocked" } } },
      { type: "turn/end", data: { turn: 4, reason: { kind: "interrupted" } } },
    ];
    entries.forEach((event, seq) => receive({ sessionId: "s", event: { seq, ...event } }));
    expect(events.map((event) => event.payload)).toEqual([
      { type: "session.busy", state: "thinking" },
      { type: "session.busy", state: "working" },
      { type: "session.busy", state: "waiting" },
      { type: "session.busy", state: "waiting" },
      { type: "session.busy", state: "working" },
      { type: "task.error", message: "dsh 任务失败，请在宿主查看详情" },
      { type: "task.cancelled" },
      { type: "session.busy", state: "waiting" },
      { type: "task.error", message: "dsh 任务中断或未正常完成，请在宿主核查" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    stop();
  });

  it("宿主事件源就绪后可观察真实 turn，注销后不再接收；不授予执行能力", async () => {
    let receive: ((entry: { sessionId: string; event: { seq: number; type: string; data: Record<string, unknown> } }) => void) | undefined;
    const adapter = new DshAdapter({
      eventSource: {
        subscribe: (listener) => {
          receive = listener;
          return () => { receive = undefined; };
        },
      },
    });
    const events: Array<{ eventId: string; taskId?: string; payload: unknown }> = [];
    const stop = await adapter.subscribe((event) => events.push(event), ctx);
    receive?.({ sessionId: "s1", event: { seq: 4, type: "turn/start", data: { turn: 1 } } });
    receive?.({ sessionId: "s1", event: { seq: 12, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
    expect(events).toMatchObject([
      { eventId: "dsh:s1:4", taskId: "s1:1", payload: { type: "task.started" } },
      { eventId: "dsh:s1:12", taskId: "s1:1", payload: { type: "task.completed" } },
    ]);
    expect(adapter.capabilities).toMatchObject({ events: true, newTask: false, approval: "none", query: "none" });
    stop();
    receive?.({ sessionId: "s1", event: { seq: 14, type: "turn/start", data: { turn: 2 } } });
    expect(events).toHaveLength(2);
  });

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
