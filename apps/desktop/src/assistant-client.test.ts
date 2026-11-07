import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { assistantCall } from "./assistant-client.js";
afterEach(() => vi.unstubAllGlobals());
it("保留服务端冲突错误码，表单草稿可以据此保留而非假报成功", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: "settings_conflict" }), {
        status: 409,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    assistantCall("client-token", "/settings", { version: 0 }, "PUT"),
  ).rejects.toMatchObject({ code: "settings_conflict" });
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringMatching(/^http:\/\/127\.0\.0\.1:18100\/v1\/assistant/),
    expect.objectContaining({
      redirect: "error",
      method: "PUT",
      headers: expect.objectContaining({
        authorization: "Bearer client-token",
      }),
    }),
  );
});
it("成功与失败响应都受读取上限约束", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 500 }),
      ),
  );
  await expect(assistantCall("client", "/snapshot")).rejects.toMatchObject({
    reason: "limit",
  });
});
