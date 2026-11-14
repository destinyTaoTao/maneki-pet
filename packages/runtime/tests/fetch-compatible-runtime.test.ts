import { afterEach, expect, it, vi } from "vitest";

import type { StartedRuntime } from "../src/runtime.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

afterEach(() => vi.unstubAllGlobals());

function runtimeStub(port: number): StartedRuntime {
  return { port, stop: vi.fn().mockResolvedValue(undefined) } as unknown as StartedRuntime;
}

it("仅为 Fetch 禁用端口停止旧实例并重选", async () => {
  const blocked = runtimeStub(6000);
  const available = runtimeStub(18100);
  const start = vi.fn().mockResolvedValueOnce(blocked).mockResolvedValueOnce(available);
  const cancel = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn()
    .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") }))
    .mockResolvedValueOnce({ body: { cancel } }));

  await expect(startFetchCompatibleRuntime({ configDir: "unused" }, start)).resolves.toBe(available);
  expect(start).toHaveBeenCalledTimes(2);
  expect(blocked.stop).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it("其他传输错误清理当前实例但不重试", async () => {
  const runtime = runtimeStub(18100);
  const start = vi.fn().mockResolvedValue(runtime);
  const failure = Object.assign(new TypeError("fetch failed"), { cause: new Error("connection refused") });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

  await expect(startFetchCompatibleRuntime({ configDir: "unused" }, start)).rejects.toBe(failure);
  expect(start).toHaveBeenCalledOnce();
  expect(runtime.stop).toHaveBeenCalledOnce();
});
