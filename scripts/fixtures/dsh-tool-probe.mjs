import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function waitFor(check, description, signal, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error(description);
}

export function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

export async function runProbe(ctx, run) {
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

export async function toolCaller(ctx, agent, server, tool, signal, expectedTools = [tool]) {
  const schemas = () => ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith(`mcp__${server}__`));
  await waitFor(() => expectedTools.every(name => schemas().includes(name)), `dsh 未发现 ${server} 的完整工具集`, signal);
  assert.deepEqual(schemas().sort(), [...expectedTools].sort());

  let call = 0;
  return async function invoke(args = {}) {
    const batch = await ctx.tools.execute({
      agent, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      calls: [{ type: "tool-call", id: "fixture-call-" + ++call, name: tool, arguments: JSON.stringify(args) }],
    });
    return batch.results[0].result;
  };
}
