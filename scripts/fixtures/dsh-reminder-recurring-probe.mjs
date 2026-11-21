import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runProbe, send, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const server = "maneki_reminder_recurring";
const createTool = "mcp__maneki_reminder_recurring__maneki_remind_daily";
const listTool = "mcp__maneki_reminder_recurring__maneki_list_daily_reminders";
const cancelTool = "mcp__maneki_reminder_recurring__maneki_cancel_daily_reminder";
const tools = [createTool, listTool, cancelTool];
const createPrompt = "每天上午九点提醒我休息";
const cancelPrompt = "取消每天上午九点的休息提醒";

function resultOf(response) {
  assert.ok(response && !response.isError, response?.content[0]?.text ?? "缺少 dsh 工具回执");
  return JSON.parse(response.content[0].text);
}

function toolCall(id, name, args) {
  return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}

async function run(ctx, { dshCli, previous }, revoked, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const prompt = previous ? cancelPrompt : createPrompt;
  const user = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
  let input;
  let receipt;

  // 本地验收 Provider 按当前用户消息取参数，取消前从工具列表查找确切系列。
  class DailyReminderFixture extends LlmAdapter {
    async *stream({ messages, tools: availableTools }) {
      for (const name of tools) assert.ok(availableTools.some(schema => schema.name === name), name);
      const turn = messages.findLast(message => message.role === "user");
      assert.equal(turn.id, user.id);
      const reply = messages.find(message => message.role === "tool" && message.toolCallId === "mutate-daily");
      let block;
      if (reply) {
        receipt = resultOf(reply);
        block = { type: "text", text: previous ? "已取消每天上午九点的休息提醒。" :
          `已设置每日提醒，下次到期时间为 ${new Date(receipt.nextAt).toISOString()}。` };
      } else if (previous) {
        const selection = /^取消每天上午([一二三四五六七八九十])点的(.+)提醒$/.exec(turn.content[0].text);
        assert.ok(selection);
        const listed = messages.find(message => message.role === "tool" && message.toolCallId === "list-daily");
        if (listed) {
          const { reminders } = resultOf(listed);
          assert.deepEqual(reminders.map(item => item.message), [selection[2], selection[2]]);
          const localTime = String("零一二三四五六七八九十".indexOf(selection[1])).padStart(2, "0") + ":00";
          const target = reminders.find(item => item.seriesId === previous.receipt.seriesId &&
            item.localTime === localTime && item.message === selection[2]);
          assert.ok(target, "找不到之前创建的九点系列");
          input = { requestId: turn.id, seriesId: target.seriesId };
          block = toolCall("mutate-daily", cancelTool, input);
        } else {
          block = toolCall("list-daily", listTool, {});
        }
      } else {
        const instruction = /^每天上午([一二三四五六七八九十])点提醒我(.+)$/.exec(turn.content[0].text);
        assert.ok(instruction);
        const localTime = String("零一二三四五六七八九十".indexOf(instruction[1])).padStart(2, "0") + ":00";
        input = { requestId: turn.id, localTime, message: instruction[2] };
        block = toolCall("mutate-daily", createTool, input);
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new DailyReminderFixture());
  const { agent } = await ctx.agents.create({
    sessionId: previous ? "cancel-daily-reminder" : "create-daily-reminder",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" },
  });
  const create = await toolCaller(ctx, agent, server, createTool, signal, tools);
  const list = await toolCaller(ctx, agent, server, listTool, signal, tools);
  const cancel = await toolCaller(ctx, agent, server, cancelTool, signal, tools);
  const other = previous?.other ?? resultOf(await create({
    requestId: "daily-control", localTime: "10:00", message: "休息",
  }));

  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  agent.followup(user);
  await waitFor(() => ended, "dsh 每日提醒对话未结束", signal, 10000);
  assert.equal(ended.kind, "completed", JSON.stringify(ended));
  assert.equal(receipt.requestId, user.id);

  if (!previous) {
    assert.deepEqual(input, { requestId: user.id, localTime: "09:00", message: "休息" });
    assert.deepEqual(resultOf(await create(input)), receipt);
    assert.deepEqual(resultOf(await list()).reminders.map(item => item.seriesId), [receipt.seriesId, other.seriesId]);
    return { tools, prompt, receipt, input, other };
  }

  assert.deepEqual(receipt, { requestId: user.id, seriesId: previous.receipt.seriesId, cancelled: true });
  assert.deepEqual(resultOf(await cancel(input)), receipt);
  assert.deepEqual(resultOf(await create(previous.input)), previous.receipt);
  assert.deepEqual(resultOf(await list()).reminders.map(item => item.seriesId), [other.seriesId]);
  await send({ type: "revoke" });
  await revoked;
  assert.equal((await list()).isError, true);
  return { prompt, receipt, cancelRetryReturnedOriginal: true, createRetryDidNotRestore: true, accessRevoked: true };
}

export const apply = (ctx, config) => runProbe(ctx, (context, revoked, signal) => run(context, config, revoked, signal));
