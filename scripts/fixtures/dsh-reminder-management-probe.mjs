import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parsePersonalIntent } from "../../packages/core/dist/index.js";
import { runProbe, send, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const createTool = "mcp__maneki_reminders__maneki_remind";
const listTool = "mcp__maneki_reminder_read__maneki_list_reminders";
const cancelTool = "mcp__maneki_reminder_cancel__maneki_cancel_reminder";
const createPrompt = "半小时后提醒我休息";
const managePrompt = "帮我看看还有哪些提醒，把刚才那个休息提醒取消掉";

function resultOf(response) {
  assert.ok(response && !response.isError, response?.content[0]?.text ?? "缺少 dsh 工具回执");
  return JSON.parse(response.content[0].text);
}

function toolCall(id, name, args) {
  return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}

async function run(ctx, dshCli, revoked, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const userMessage = text => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
  const createUser = userMessage(createPrompt);
  const manageUser = userMessage(managePrompt);
  let created;
  let cancelInput;
  let cancelled;

  // 本地确定性 Provider 只处理验收中的两轮。选择「刚才那个」时读取上一轮 MCP 回执和本轮列表。
  class ReminderManagementFixture extends LlmAdapter {
    async *stream({ messages, tools }) {
      for (const tool of [createTool, listTool, cancelTool]) assert.ok(tools.some(schema => schema.name === tool), tool);
      const user = messages.findLast(message => message.role === "user");
      const response = id => messages.find(message => message.role === "tool" && message.toolCallId === id);
      let block;
      if (user.id === createUser.id) {
        assert.deepEqual(user.content, createUser.content);
        if (response("create-reminder")) {
          created = resultOf(response("create-reminder"));
          block = { type: "text", text: `已设置休息提醒，到期时间为 ${new Date(created.remindAt).toISOString()}。` };
        } else {
          const now = Date.now();
          const intent = parsePersonalIntent(user.content[0].text, now, "Asia/Shanghai");
          assert.equal(intent.kind, "reminder");
          block = toolCall("create-reminder", createTool, {
            requestId: user.id, afterSeconds: (intent.remindAt - now) / 1000, message: intent.message,
          });
        }
      } else {
        assert.equal(user.id, manageUser.id);
        assert.deepEqual(user.content, manageUser.content);
        if (response("cancel-reminder")) {
          cancelled = resultOf(response("cancel-reminder"));
          assert.deepEqual(cancelled, { requestId: user.id, reminderId: cancelInput.reminderId, cancelled: true });
          block = { type: "text", text: "查到两条休息提醒，刚才设置的那条已取消，还剩一条。" };
        } else if (response("list-reminders")) {
          const previous = resultOf(response("create-reminder"));
          const { reminders } = resultOf(response("list-reminders"));
          assert.deepEqual(reminders.map(item => item.message), ["休息", "休息"]);
          const target = reminders.find(item => item.reminderId === previous.reminderId && item.message === "休息");
          assert.ok(target, "本轮列表中没有上一轮创建的提醒");
          cancelInput = { requestId: user.id, reminderId: target.reminderId, version: target.version };
          block = toolCall("cancel-reminder", cancelTool, cancelInput);
        } else {
          block = toolCall("list-reminders", listTool, {});
        }
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new ReminderManagementFixture());
  const { agent } = await ctx.agents.create({ sessionId: "reminder-management-test-session",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" } });
  const create = await toolCaller(ctx, agent, "maneki_reminders", createTool, signal);
  const list = await toolCaller(ctx, agent, "maneki_reminder_read", listTool, signal);
  const cancel = await toolCaller(ctx, agent, "maneki_reminder_cancel", cancelTool, signal);
  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  async function runTurn(user) {
    ended = undefined;
    agent.followup(user);
    await waitFor(() => ended, "dsh 提醒对话未结束", signal, 10000);
    assert.equal(ended.kind, "completed", JSON.stringify(ended));
  }

  const other = resultOf(await create({ requestId: "previous-same-title", afterSeconds: 1200, message: "休息" }));
  await runTurn(createUser);
  assert.equal(created.requestId, createUser.id);
  assert.notEqual(created.reminderId, other.reminderId);

  const pending = resultOf(await list()).reminders;
  assert.deepEqual(pending.map(item => item.reminderId), [other.reminderId, created.reminderId]);
  const [otherRow, target] = pending;
  const stale = await cancel({ requestId: "wrong-version", reminderId: target.reminderId, version: target.version + 1 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /HTTP 409/);
  assert.deepEqual(resultOf(await list()).reminders, pending);

  await runTurn(manageUser);
  assert.equal(cancelled.reminderId, created.reminderId);
  assert.equal(cancelInput.version, target.version);
  assert.deepEqual(resultOf(await cancel(cancelInput)), cancelled);
  const reused = await cancel({ ...cancelInput, reminderId: otherRow.reminderId, version: otherRow.version });
  assert.equal(reused.isError, true);
  assert.match(reused.content[0].text, /HTTP 409/);
  assert.deepEqual(resultOf(await list()).reminders, [otherRow]);

  await send({ type: "revoke" });
  await revoked;
  const rejected = await cancel({ requestId: "after-revocation", reminderId: otherRow.reminderId, version: otherRow.version });
  assert.equal(rejected.isError, true);
  assert.deepEqual(resultOf(await list()).reminders, [otherRow]);
  return { tools: [createTool, listTool, cancelTool], prompts: [createPrompt, managePrompt], created, other, cancelled,
    staleVersionRejected: true, retryReturnedOriginal: true, retargetedRequestRejected: true, revokePreservedRead: true };
}

export const apply = (ctx, { dshCli }) => runProbe(ctx, (context, revoked, signal) => run(context, dshCli, revoked, signal));
