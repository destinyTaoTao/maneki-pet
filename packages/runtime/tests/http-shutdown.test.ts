import { request, type ClientRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hashToken } from "../src/auth.js";
import { startRuntime, type StartedRuntime } from "../src/runtime.js";

async function incompleteSettingsRequest(runtime: StartedRuntime): Promise<{ request: ClientRequest; response: Promise<number | null> }> {
  const token = "synthetic-shutdown-settings";
  runtime.store.createClient({ clientId: "shutdown-settings", name: "test", tokenHash: hashToken(token), scopes: ["settings"], createdAt: new Date().toISOString() });
  const body = JSON.stringify({ enabled: true });
  const req = request({ hostname: "127.0.0.1", port: runtime.port, path: "/v1/dnd", method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), expect: "100-continue",
  } });
  const response = new Promise<number | null>((resolve) => {
    req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? null); });
    req.on("error", () => resolve(null));
  });
  const continuing = new Promise<void>((resolve) => req.once("continue", resolve));
  req.flushHeaders();
  await continuing;
  req.write(body.slice(0, -1));
  return { request: req, response };
}

it("未传完的鉴权 HTTP 请求不能使 Runtime 退出长期等待", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-http-shutdown-"));
  const runtime = await startRuntime({ configDir: directory });
  let req: ClientRequest | undefined;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    req = (await incompleteSettingsRequest(runtime)).request;
    stopping = runtime.stop();
    const stopped = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    expect(stopped).toBe(true);
    expect(runtime.state()).toBe("stopped");
  } finally {
    clearTimeout(timer);
    req?.destroy();
    await stopping;
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("退出开始后补齐的请求体不能再修改共享设置或返回成功", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-http-shutdown-late-"));
  const runtime = await startRuntime({ configDir: directory });
  const writes = vi.spyOn(runtime.store, "kvSet");
  let req: ClientRequest | undefined;
  let stopping: Promise<void> | undefined;
  try {
    const pending = await incompleteSettingsRequest(runtime);
    req = pending.request;
    stopping = runtime.stop();
    req.end("}");
    expect(await pending.response).not.toBe(200);
    await stopping;
    expect(writes.mock.calls.some(([key]) => key === "dnd")).toBe(false);
  } finally {
    req?.destroy();
    await stopping;
    await runtime.stop();
    writes.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
