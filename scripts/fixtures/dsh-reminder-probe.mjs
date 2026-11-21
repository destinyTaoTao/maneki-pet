import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parsePersonalIntent } from "../../packages/core/dist/index.js";
import { runProbe, send, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const tool = "mcp__maneki_reminders__maneki_remind";
const prompt = "半小时后提醒我休息";

async function run(ctx, dshCli, revoked, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const user = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
  let args;
  let receipt;
  // 本地确定性 Provider。消息、工具声明与下一步的工具回执均来自 dsh 原生循环。
  class ReminderFixture extends LlmAdapter {
    async *stream({ messages, tools }) {
      let block;
      if (!args) {
        assert.ok(tools.some(schema => schema.name === tool));
        const input = messages.find(message => message.role === "user" && message.id === user.id);
        assert.deepEqual(input.content, user.content);
        const now = Date.now();
        const intent = parsePersonalIntent(input.content[0].text, now, "Asia/Shanghai");
        assert.equal(intent.kind, "reminder");
        args = { requestId: input.id, afterSeconds: (intent.remindAt - now) / 1000, message: intent.message };
        block = { type: "tool-call", id: "reminder-call", name: tool, arguments: JSON.stringify(args) };
      } else {
        const response = messages.find(message => message.role === "tool" && message.toolCallId === "reminder-call");
        assert.ok(response && !response.isError, response?.content[0]?.text);
        receipt = JSON.parse(response.content[0].text);
        block = { type: "text", text: `已设置提醒，到期时间为 ${new Date(receipt.remindAt).toISOString()}。` };
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }
  ctx.llm.registerAdapter(["fixture"], new ReminderFixture());
  const { agent } = await ctx.agents.create({ sessionId: "reminder-test-session",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" } });
  const invoke = await toolCaller(ctx, agent, "maneki_reminders", tool, signal);
  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  agent.followup(user);
  await waitFor(() => ended, "dsh 提醒对话未结束", signal, 10000);
  assert.equal(ended.kind, "completed", JSON.stringify(ended));
  assert.equal(args.afterSeconds, 1800);
  assert.equal(args.message, "休息");
  assert.equal(receipt.requestId, user.id);

  const retry = await invoke(args);
  assert.equal(retry.isError, false, retry.content[0]?.text);
  assert.deepEqual(JSON.parse(retry.content[0].text), receipt);
  await send({ type: "revoke" });
  await revoked;
  const rejected = await invoke({ ...args, requestId: "after-revocation" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /提醒/);
  return { tool, prompt, receipt, retryReturnedOriginal: true, revoked: true };
}

export const apply = (ctx, { dshCli }) => runProbe(ctx, (context, revoked, signal) => run(context, dshCli, revoked, signal));
