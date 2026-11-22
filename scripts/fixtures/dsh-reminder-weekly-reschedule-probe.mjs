import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runProbe, toolCaller, waitFor } from "./dsh-tool-probe.mjs";

export const inject = ["tools", "agents", "agentLoop", "llm"];
const server = "maneki_week_move";
const listTool = `mcp__${server}__maneki_list_weekly_reschedule_targets`;
const rescheduleTool = `mcp__${server}__maneki_reschedule_weekly_reminder`;
const tools = [listTool, rescheduleTool];
const prompt = "把每周一、三、五上午九点的休息提醒改到上午十点";
const pattern = /^把每周([一二三四五六日](?:、[一二三四五六日])*)上午([一二三四五六七八九十])点的(.+)提醒改到上午([一二三四五六七八九十])点$/;

function resultOf(response) {
  assert.ok(response && !response.isError, response?.content[0]?.text ?? "缺少 dsh 工具回执");
  return JSON.parse(response.content[0].text);
}

function localTime(hour) {
  return String("零一二三四五六七八九十".indexOf(hour)).padStart(2, "0") + ":00";
}

const toolCall = (id, name, input) => ({ type: "tool-call", id, name, arguments: JSON.stringify(input) });

async function run(ctx, { dshCli, scenario, seriesId }, signal) {
  assert.ok(tools.every(name => name.length <= 64), "dsh 工具名超长");
  const llm = createRequire(dshCli).resolve("@deepseek-ai/dsh-llm");
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(llm));
  const user = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
  let input;
  let receipt;

  // 测试预置系列 ID 仅用于断言，对话从用户指令和 MCP 列表取得改期参数。
  class WeeklyRescheduleFixture extends LlmAdapter {
    async *stream({ messages, tools: availableTools }) {
      for (const name of tools) assert.ok(availableTools.some(schema => schema.name === name), name);
      const turn = messages.findLast(message => message.role === "user");
      assert.equal(turn.id, user.id);
      const instruction = pattern.exec(turn.content[0].text);
      assert.ok(instruction);
      const [, days, oldHour, message, newHour] = instruction;
      const daysOfWeek = days.split("、").map(day => "一二三四五六日".indexOf(day) + 1).sort((a, b) => a - b);
      const result = id => messages.find(message => message.role === "tool" && message.toolCallId === id);
      const mutation = result("reschedule");
      const list = result("list-targets");
      let block;
      if (mutation) {
        receipt = resultOf(mutation);
        block = { type: "text", text: `已改到每周${days} ${receipt.localTime}，下次到期时间为 ${new Date(receipt.nextAt).toISOString()}。` };
      } else if (list) {
        const { reminders } = resultOf(list);
        const sameTimeAndMessage = reminders.filter(item => item.localTime === localTime(oldHour) && item.message === message);
        assert.equal(sameTimeAndMessage.length, 2, "需要同名同时间、不同星期的对照系列");
        const matches = sameTimeAndMessage.filter(item => item.daysOfWeek.join(",") === daysOfWeek.join(","));
        assert.equal(matches.length, 1, "需要唯一的提醒改期目标");
        const [target] = matches;
        input = { requestId: turn.id, seriesId: target.seriesId, version: target.version, localTime: localTime(newHour) };
        block = toolCall("reschedule", rescheduleTool, input);
      } else {
        block = toolCall("list-targets", listTool, {});
      }
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }

  ctx.llm.registerAdapter(["fixture"], new WeeklyRescheduleFixture());
  const { agent } = await ctx.agents.create({ sessionId: scenario,
    meta: { cwd: process.cwd() }, agentOptions: { provider: "fixture", model: "fixture" } });
  const reschedule = await toolCaller(ctx, agent, server, rescheduleTool, signal, tools);
  let ended;
  ctx.on("session/event", (session, event) => {
    if (session.id === agent.id && event.type === "turn/end") ended = event.data.reason;
  });
  agent.followup(user);
  await waitFor(() => ended, "dsh 指定星期提醒改期对话未结束", signal, 10000);
  assert.equal(ended.kind, "completed", JSON.stringify(ended));
  assert.deepEqual(input, { requestId: user.id, seriesId, version: 1, localTime: "10:00" });
  assert.deepEqual(resultOf(await reschedule(input)), receipt);
  const conflict = await reschedule({ ...input, requestId: "stale-version", localTime: "11:00" });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /HTTP 409/);

  return { tools, prompt, input, receipt, retryReturnedOriginal: true, staleVersionRejected: true };
}

export const apply = (ctx, config) => runProbe(ctx, (context, _revoked, signal) => run(context, config, signal));
