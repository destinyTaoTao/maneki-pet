import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parsePersonalIntent } from "../../packages/core/dist/index.js";
import { runProbe, send, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const createTool = "mcp__maneki_reminders__maneki_remind";
const listTool = "mcp__maneki_reminder_read__maneki_list_reminders";
const rescheduleTool = "mcp__maneki_reminder_reschedule__maneki_reschedule_reminder";
const createPrompt = "半小时后提醒我休息";
const reschedulePrompt = "把刚才那个休息提醒改到一小时后";

function resultOf(response) {
  assert.ok(response && !response.isError, response?.content[0]?.text ?? "缺少 dsh 工具回执");
  return JSON.parse(response.content[0].text);
}

function assertConflict(response) {
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /HTTP 409/);
}

function toolCall(id, name, args) {
  return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}

async function run(ctx, dshCli, revoked, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const userMessage = text => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
  const createUser = userMessage(createPrompt);
  const rescheduleUser = userMessage(reschedulePrompt);
  let created;
  let rescheduleInput;
  let rescheduled;

  // 验收 Provider 根据本轮语句、上一轮 MCP 回执和本轮列表选择目标。
  class ReminderRescheduleFixture extends LlmAdapter {
    async *stream({ messages, tools }) {
      for (const tool of [createTool, listTool, rescheduleTool]) assert.ok(tools.some(schema => schema.name === tool), tool);
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
        assert.equal(user.id, rescheduleUser.id);
        const instruction = /^把刚才那个(.+)提醒改到一小时后$/.exec(user.content[0].text);
        assert.ok(instruction);
        if (response("reschedule-reminder")) {
          rescheduled = resultOf(response("reschedule-reminder"));
          block = { type: "text", text: `刚才设置的休息提醒已改到 ${new Date(rescheduled.remindAt).toISOString()}。` };
        } else if (response("list-reminders")) {
          const previous = resultOf(response("create-reminder"));
          const { reminders } = resultOf(response("list-reminders"));
          assert.deepEqual(reminders.map(item => item.message), [instruction[1], instruction[1]]);
          const target = reminders.find(item => item.reminderId === previous.reminderId && item.message === instruction[1]);
          assert.ok(target, "本轮列表中没有上一轮创建的提醒");
          rescheduleInput = { requestId: user.id, reminderId: target.reminderId, version: target.version, afterSeconds: 3600 };
          block = toolCall("reschedule-reminder", rescheduleTool, rescheduleInput);
        } else {
          block = toolCall("list-reminders", listTool, {});
        }
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new ReminderRescheduleFixture());
  const { agent } = await ctx.agents.create({ sessionId: "reminder-reschedule-test-session",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" } });
  const create = await toolCaller(ctx, agent, "maneki_reminders", createTool, signal);
  const list = await toolCaller(ctx, agent, "maneki_reminder_read", listTool, signal);
  const reschedule = await toolCaller(ctx, agent, "maneki_reminder_reschedule", rescheduleTool, signal);
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
  const pending = resultOf(await list()).reminders;
  assert.deepEqual(pending.map(item => item.reminderId), [other.reminderId, created.reminderId]);
  const [otherRow, target] = pending;

  await runTurn(rescheduleUser);
  assert.equal(rescheduled.requestId, rescheduleUser.id);
  assert.equal(rescheduled.reminderId, created.reminderId);
  assert.equal(rescheduleInput.version, target.version);
  assert.equal(rescheduled.version, target.version + 1);
  assert.deepEqual(resultOf(await reschedule(rescheduleInput)), rescheduled);
  assertConflict(await reschedule({ ...rescheduleInput, requestId: "stale-version" }));
  assertConflict(await reschedule({ ...rescheduleInput, afterSeconds: 7200 }));
  assertConflict(await reschedule({ ...rescheduleInput, reminderId: otherRow.reminderId, version: otherRow.version }));

  const current = [otherRow, { ...target, remindAt: rescheduled.remindAt, version: rescheduled.version }];
  assert.deepEqual(resultOf(await list()).reminders, current);
  await send({ type: "revoke" });
  await revoked;
  const rejected = await reschedule({ requestId: "after-revocation", reminderId: otherRow.reminderId,
    version: otherRow.version, afterSeconds: 3600 });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /无法验证 Runtime 的提醒改期身份/);
  assert.deepEqual(resultOf(await create({ requestId: created.requestId, afterSeconds: 1800, message: "休息" })), created);
  assert.deepEqual(resultOf(await list()).reminders, current);

  return { tools: [createTool, listTool, rescheduleTool], prompts: [createPrompt, reschedulePrompt], created, other, rescheduled,
    originalVersion: target.version, staleVersionRejected: true, retryReturnedOriginal: true, reusedRequestRejected: true,
    sameTitleUnchanged: true, revokePreservedCreateAndRead: true };
}

export const apply = (ctx, { dshCli }) => runProbe(ctx, (context, revoked, signal) => run(context, dshCli, revoked, signal));
