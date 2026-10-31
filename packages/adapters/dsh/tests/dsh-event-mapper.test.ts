import { describe, expect, it } from "vitest";

import { DshEventMapper } from "../src/index.js";

const SESSION_LINE =
  '{"type":"session","sessionId":"session-9f34fd12-9172-44a6-8ebd-5913c872571e","cwd":"C:\\\\Users\\\\demo\\\\dsh-live"}';

function makeMapper(): DshEventMapper {
  let tick = 0;
  return new DshEventMapper({
    adapterId: "dsh",
    now: () => new Date(1_700_000_000_000 + (tick += 1) * 1000),
  });
}

describe("DshEventMapper：spike 实测行 → HarnessEvent", () => {
  it("session 行建立会话身份，不产生事件", () => {
    const mapper = makeMapper();
    expect(mapper.mapLine(SESSION_LINE)).toEqual([]);
    expect(mapper.knownSessionId).toBe("session-9f34fd12-9172-44a6-8ebd-5913c872571e");
  });

  it("turn_start → task.started；thinking → session.busy(thinking)；text → task.progress", () => {
    const mapper = makeMapper();
    mapper.mapLine(SESSION_LINE);
    const started = mapper.mapLine('{"type":"status","phase":"turn_start","turn":1}');
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toEqual({ type: "task.started", summary: "turn 1 started" });

    const thinking = mapper.mapLine('{"type":"thinking","text":""}');
    expect(thinking[0]?.payload).toEqual({ type: "session.busy", state: "thinking" });

    const text = mapper.mapLine('{"type":"text","text":"SPIKE-OK"}');
    expect(text[0]?.payload).toEqual({ type: "task.progress", summary: "SPIKE-OK" });
  });

  it("step_end 的 usage 计量与 turn_end(completed) 不进事件流（防洪泛）", () => {
    const mapper = makeMapper();
    mapper.mapLine(SESSION_LINE);
    expect(
      mapper.mapLine(
        '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":7003,"outputTokens":6,"totalTokens":7009}}',
      ),
    ).toEqual([]);
    expect(mapper.mapLine('{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}')).toEqual([]);
  });

  it("final → task.completed（summary 为最终文本）", () => {
    const mapper = makeMapper();
    mapper.mapLine(SESSION_LINE);
    const events = mapper.mapLine('{"type":"final","text":"SPIKE-OK"}');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ type: "task.completed", summary: "SPIKE-OK" });
  });

  it("MISSING_CREDENTIAL 的 turn_end(error) → task.error（首轮 spike 实测行）", () => {
    const mapper = makeMapper();
    mapper.mapLine(SESSION_LINE);
    const events = mapper.mapLine(
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \\"deepseek-official\\"","code":"MISSING_CREDENTIAL"}}}',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      type: "task.error",
      message: 'llm-deepseek: no API key for provider route "deepseek-official"',
    });
  });

  it("顶层 error 行 → task.error；tool_call → busy(working)+progress；tool_result(error) → progress", () => {
    const mapper = makeMapper();
    mapper.mapLine(SESSION_LINE);
    expect(mapper.mapLine('{"type":"error","message":"unknown option \'-n\'"}')[0]?.payload).toEqual({
      type: "task.error",
      message: "unknown option '-n'",
    });
    const toolCall = mapper.mapLine(
      '{"type":"tool_call","callId":"call_1","tool":"pwsh","input":{"command":"ping -n 45 127.0.0.1"}}',
    );
    expect(toolCall.map((event) => event.payload.type)).toEqual(["session.busy", "task.progress"]);
    const toolFail = mapper.mapLine('{"type":"tool_result","callId":"call_1","status":"error","result":"boom"}');
    expect(toolFail[0]?.payload).toEqual({ type: "task.progress", summary: "tool failed: boom" });
    expect(mapper.mapLine('{"type":"tool_result","callId":"call_1","status":"completed","result":"ok"}')).toEqual([]);
  });

  it("未知类型、坏 JSON、会话前行都被安全跳过", () => {
    const mapper = makeMapper();
    expect(mapper.mapLine('{"type":"mystery","x":1}')).toEqual([]);
    expect(mapper.mapLine("not-json-at-all")).toEqual([]);
    expect(mapper.mapLine('{"type":"status","phase":"turn_start","turn":1}')).toEqual([]);
  });

  it("完整实测转录：事件序列、sequence 单调、streamId/taskId 绑定会话", () => {
    const mapper = makeMapper();
    const transcript = [
      SESSION_LINE,
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"thinking","text":""}',
      '{"type":"text","text":"SPIKE-OK"}',
      '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":7003,"outputTokens":6,"totalTokens":7009}}',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":"SPIKE-OK"}',
    ];
    const events = transcript.flatMap((line) => mapper.mapLine(line));
    expect(events.map((event) => event.payload.type)).toEqual([
      "task.started",
      "session.busy",
      "task.progress",
      "task.completed",
    ]);
    const sequences = events.map((event) => event.sequence ?? 0);
    expect(sequences).toEqual([1, 2, 3, 4]);
    for (const event of events) {
      expect(event.sessionId).toBe("session-9f34fd12-9172-44a6-8ebd-5913c872571e");
      expect(event.taskId).toBe(event.sessionId);
      expect(event.streamId).toBe(`dsh-headless-${event.sessionId}`);
      expect(event.adapterId).toBe("dsh");
    }
  });
});
