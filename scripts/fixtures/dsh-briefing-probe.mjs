import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const inject = ["tools", "agents", "agentLoop", "userQuestions"];
const tool = "mcp__maneki__maneki_get_briefing";
const sessionId = "briefing-test-session";

async function waitFor(check, description, signal) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error(description);
}

async function run(ctx, revoked, signal) {
  const handle = await ctx.agents.create({
    sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" },
  });
  const { agent } = handle;
  const schemas = () => ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith("mcp__maneki__"));
  await waitFor(() => schemas().includes(tool), "dsh 未发现简报工具", signal);
  assert.deepEqual(schemas(), [tool]);

  let call = 0;
  async function invoke() {
    const batch = await ctx.tools.execute({
      agent, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      calls: [{ type: "tool-call", id: "fixture-briefing-" + ++call, name: tool, arguments: "{}" }],
    });
    return batch.results[0].result;
  }
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

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

export async function apply(ctx) {
  const revoked = Promise.withResolvers();
  const cancel = new AbortController();
  function stop() {
    cancel.abort();
    revoked.resolve();
  }
  process.on("message", message => {
    if (message === "revoked") revoked.resolve();
    if (message === "stop") stop();
  });
  process.once("disconnect", stop);
  // dsh 先完成 profile 装配，再从真实宿主工具注册表执行。
  setImmediate(async () => {
    try {
      const result = await run(ctx, revoked.promise, cancel.signal);
      await send({ type: "passed", result });
    } catch (error) {
      if (process.connected && !cancel.signal.aborted) await send({ type: "failed", error: String(error.stack ?? error) });
    } finally {
      if (process.connected) process.disconnect();
      // 走 dsh 的信号处理器，让它 await Cordis 插件析构和 MCP 子进程关闭。
      process.emit("SIGTERM");
    }
  });
}
