import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runProbe, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const server = "maneki_daily_move";
const listTool = `mcp__${server}__maneki_list_daily_reschedule_targets`;
const rescheduleTool = `mcp__${server}__maneki_reschedule_daily_reminder`;
const tools = [listTool, rescheduleTool];
const prompt = "把每天上午九点的休息提醒改到每天上午十点";

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

function localTime(hour) {
  return String("零一二三四五六七八九十".indexOf(hour)).padStart(2, "0") + ":00";
}

async function run(ctx, { dshCli, seriesId }, signal) {
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const user = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
  let input;
  let receipt;

  // 仅从本轮用户指令和 MCP 列表获取改期参数。预置系列 ID 只用于断言。
  class DailyRescheduleFixture extends LlmAdapter {
    async *stream({ messages, tools: availableTools }) {
      for (const name of tools) assert.ok(availableTools.some(schema => schema.name === name), name);
      const turn = messages.findLast(message => message.role === "user");
      const response = id => messages.find(message => message.role === "tool" && message.toolCallId === id);
      assert.equal(turn.id, user.id);
      const instruction = /^把每天上午([一二三四五六七八九十])点的(.+)提醒改到每天上午([一二三四五六七八九十])点$/.exec(turn.content[0].text);
      assert.ok(instruction);

      let block;
      if (response("reschedule-daily")) {
        receipt = resultOf(response("reschedule-daily"));
        block = { type: "text", text: `已改到每日 ${receipt.localTime}，下次到期时间为 ${new Date(receipt.nextAt).toISOString()}。` };
      } else if (response("list-daily-targets")) {
        const { reminders } = resultOf(response("list-daily-targets"));
        const matches = reminders.filter(item => item.localTime === localTime(instruction[1]) && item.message === instruction[2]);
        assert.equal(matches.length, 1, "需要唯一的提醒改期目标");
        const [target] = matches;
        input = { requestId: turn.id, seriesId: target.seriesId, version: target.version, localTime: localTime(instruction[3]) };
        block = toolCall("reschedule-daily", rescheduleTool, input);
      } else {
        block = toolCall("list-daily-targets", listTool, {});
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new DailyRescheduleFixture());
  const { agent } = await ctx.agents.create({ sessionId: "daily-reminder-reschedule",
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" } });
  const reschedule = await toolCaller(ctx, agent, server, rescheduleTool, signal, tools);
  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  agent.followup(user);
  await waitFor(() => ended, "dsh 每日提醒改期对话未结束", signal, 10000);
  assert.equal(ended.kind, "completed", JSON.stringify(ended));
  assert.deepEqual(input, { requestId: user.id, seriesId, version: 1, localTime: "10:00" });
  assert.deepEqual(resultOf(await reschedule(input)), receipt);
  assertConflict(await reschedule({ ...input, requestId: "stale-daily-version", localTime: "11:00" }));
  assertConflict(await reschedule({ ...input, localTime: "11:00" }));

  return { tools, prompt, receipt, input, staleVersionRejected: true, retryReturnedOriginal: true, reusedRequestRejected: true };
}

export const apply = (ctx, config) => runProbe(ctx, (context, _revoked, signal) => run(context, config, signal));
