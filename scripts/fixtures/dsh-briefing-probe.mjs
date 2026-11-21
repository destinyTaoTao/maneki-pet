import assert from "node:assert/strict";
import { runProbe, send, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "userQuestions"];
const tool = "mcp__maneki__maneki_get_briefing";
const sessionId = "briefing-test-session";

async function run(ctx, revoked, signal) {
  const handle = await ctx.agents.create({
    sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" },
  });
  const { agent } = handle;
  const invoke = await toolCaller(ctx, agent, "maneki", tool, signal);
  async function briefing() {
    const result = await invoke();
    assert.equal(result.isError, false, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  }

  // 仅 turn/step 由测试启动。原生工具负责发出 tool/call 并挂起等待回答。
  const question = Promise.withResolvers();
  const answer = Promise.withResolvers();
  ctx.on("user-questions/request", async () => {
    question.resolve();
    return answer.promise;
  });
  const turnStep = { turn: 0, step: 0 };
  agent.session.append("turn/start", { turn: 0 });
  agent.session.append("step/start", turnStep);
  const ask = ctx.tools.execute({
    agent, log: turnStep, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    calls: [{ type: "tool-call", id: "fixture-question", name: "ask_user_question",
      arguments: JSON.stringify({ questions: [{ id: "fixture-q", question: "Fixture question?" }] }) }],
  });
  let waiting;
  try {
    await Promise.race([question.promise, ask.then(() => { throw new Error("提问工具在收到回答前返回"); })]);
    waiting = await waitFor(async () => {
      const reply = await briefing();
      return reply.waiting.some(row => row.sessionId === sessionId) && reply;
    }, "未读到正在等待的宿主会话", signal);
    assert.deepEqual(waiting.todos, [{ title: "Fixture due item", dueDate: "2024-01-03" }]);
    assert.equal(waiting.onlineSources, 1);
    assert.equal(waiting.waiting.length, 1);
    assert.equal(waiting.waiting[0].profileId, "acceptance");
    assert.equal(waiting.waiting[0].projectName, "fixture-project");
  } finally {
    answer.resolve({ answers: [{ id: "fixture-q", selected: [], custom: "Fixture answer" }] });
  }
  assert.equal((await ask).results[0].result.isError, false);
  agent.session.append("step/end", turnStep);
  agent.session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
  const settled = await waitFor(async () => {
    const reply = await briefing();
    return reply.onlineSources === 1 && reply.waiting.length === 0 && reply;
  }, "宿主答复后简报仍列出等待会话", signal);

  await send({ type: "revoke" });
  await revoked;
  signal.throwIfAborted();
  const rejected = await invoke();
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /简报/);
  return { tool, todos: waiting.todos, waiting: waiting.waiting, waitingAfterAnswer: settled.waiting, revoked: true };
}

export const apply = ctx => runProbe(ctx, run);
