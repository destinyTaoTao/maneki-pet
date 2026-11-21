import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runProbe, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const server = "maneki_reminder_weekdays";
const [createTool, listTool, cancelTool] = [
  "maneki_remind_weekdays", "maneki_list_weekday_reminders", "maneki_cancel_weekday_reminder",
].map(name => `mcp__${server}__${name}`);
const tools = [createTool, listTool, cancelTool];
const createPrompt = "每个工作日上午九点提醒我休息";
const cancelPrompt = "取消每个工作日上午九点的休息提醒";

function resultOf(response) {
  assert.ok(response && !response.isError, response?.content[0]?.text ?? "缺少 dsh 工具回执");
  return JSON.parse(response.content[0].text);
}

const call = (id, name, input) => ({ type: "tool-call", id, name, arguments: JSON.stringify(input) });

async function run(ctx, { dshCli, previous }, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const prompt = previous ? cancelPrompt : createPrompt;
  const user = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
  let input;
  let receipt;

  class WeekdayReminderFixture extends LlmAdapter {
    async *stream({ messages, tools: availableTools }) {
      for (const name of tools) assert.ok(availableTools.some(schema => schema.name === name), name);
      const turn = messages.findLast(message => message.role === "user");
      assert.equal(turn.id, user.id);
      assert.equal(turn.content[0].text, prompt);
      const mutation = messages.find(message => message.role === "tool" && message.toolCallId === "mutate-weekday");
      const list = messages.find(message => message.role === "tool" && message.toolCallId === "list-weekdays");
      let block;
      if (mutation) {
        receipt = resultOf(mutation);
        block = { type: "text", text: previous ? "已取消工作日休息提醒。" :
          `已设置工作日提醒，下次到期时间为 ${new Date(receipt.nextAt).toISOString()}。` };
      } else if (!previous) {
        input = { requestId: turn.id, localTime: "09:00", message: "休息" };
        block = call("mutate-weekday", createTool, input);
      } else if (!list) {
        block = call("list-weekdays", listTool, {});
      } else {
        const matches = resultOf(list).reminders.filter(item => item.localTime === "09:00" && item.message === "休息");
        assert.equal(matches.length, 1, "找不到唯一的九点休息提醒");
        assert.equal(matches[0].seriesId, previous.receipt.seriesId);
        input = { requestId: turn.id, seriesId: matches[0].seriesId };
        block = call("mutate-weekday", cancelTool, input);
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new WeekdayReminderFixture());
  const { agent } = await ctx.agents.create({
    sessionId: previous ? "cancel-weekday-reminder" : "create-weekday-reminder",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" },
  });
  const create = await toolCaller(ctx, agent, server, createTool, signal, tools);
  const list = await toolCaller(ctx, agent, server, listTool, signal, tools);
  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  agent.followup(user);
  await waitFor(() => ended, "dsh 工作日提醒对话未结束", signal, 10000);
  assert.equal(ended.kind, "completed", JSON.stringify(ended));
  assert.equal(receipt.requestId, user.id);

  if (!previous) {
    assert.deepEqual(resultOf(await create(input)), receipt);
    assert.deepEqual(resultOf(await list()).reminders.map(item => item.seriesId), [receipt.seriesId]);
    return { tools, prompt, receipt, input };
  }

  const cancel = await toolCaller(ctx, agent, server, cancelTool, signal, tools);
  assert.deepEqual(receipt, { requestId: user.id, seriesId: previous.receipt.seriesId, cancelled: true });
  assert.deepEqual(resultOf(await cancel(input)), receipt);
  assert.deepEqual(resultOf(await create(previous.input)), previous.receipt);
  assert.deepEqual(resultOf(await list()).reminders, []);
  return { prompt, receipt, cancelRetryReturnedOriginal: true, createRetryDidNotRestore: true };
}

export const apply = (ctx, config) => runProbe(ctx, (context, _revoked, signal) => run(context, config, signal));
