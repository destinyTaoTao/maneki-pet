import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, it } from "vitest";
import { HttpChatProvider } from "../src/chat-http-provider.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function provider(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = defaultAssistantSettings();
  settings.chat = {
    ...settings.chat,
    enabled: true,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: "fixture",
  };
  return new HttpChatProvider(settings, "fixture-key");
}
const ctx = () => ({
  requestId: "test",
  signal: new AbortController().signal,
  deadlineAtMs: Date.now() + 2000,
});
const reply = {
  choices: [
    {
      message: { content: "<script>仅是文本</script>" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
};
it("发送受限非流式协议并读取用量，不发送工具或自动执行内容", async () => {
  let captured: unknown;
  const client = await provider((req, res) => {
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer fixture-key");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      captured = JSON.parse(body);
      res.end(JSON.stringify(reply));
    });
  });
  expect(
    await client.reply({ messages: [{ role: "user", text: "hello" }] }, ctx()),
  ).toEqual({
    text: "<script>仅是文本</script>",
    usage: { inputTokens: 12, outputTokens: 5 },
  });
  expect(captured).toEqual({
    model: "fixture",
    stream: false,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
  });
});
it("重定向不追随，认证错误不泄漏正文，缺少用量与截断答案不能伪装完成", async () => {
  for (const [status, body, code] of [
    [302, "secret", "provider_unavailable"],
    [401, "private-key", "provider_auth_failed"],
    [200, JSON.stringify({ choices: reply.choices }), "metering_unavailable"],
    [
      200,
      JSON.stringify({
        ...reply,
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
      }),
      "provider_incomplete_response",
    ],
    [200, "x".repeat(270000), "provider_response_too_large"],
  ] as const) {
    let calls = 0;
    const client = await provider((_req, res) => {
      calls++;
      res.writeHead(status, { location: "http://127.0.0.1:1/private" });
      res.end(body);
    });
    await expect(client.reply({ messages: [] }, ctx())).rejects.toMatchObject({
      code,
    });
    expect(calls).toBe(1);
  }
});
it("超时和主动取消分别返回错误，不重试", async () => {
  const client = await provider(() => undefined);
  await expect(
    client.reply({ messages: [] }, { ...ctx(), deadlineAtMs: Date.now() + 30 }),
  ).rejects.toMatchObject({ code: "provider_timeout" });
  const controller = new AbortController();
  const pending = client.reply(
    { messages: [] },
    { ...ctx(), signal: controller.signal },
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "chat_cancelled" });
});
