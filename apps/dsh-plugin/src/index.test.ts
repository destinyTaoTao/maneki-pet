import { afterEach, expect, it, vi } from "vitest";
import { apply, type DshPluginContext } from "./index.js";
import { controlAssistant } from "./assistant-control.js";
vi.mock("./assistant-control.js", () => ({ controlAssistant: vi.fn() }));

type Command = Parameters<DshPluginContext["commands"]["register"]>[0];
let dispose: (() => Promise<void>) | undefined;
let command: Command | undefined;
const unregister = vi.fn();
const removeEvents = vi.fn();
const context: DshPluginContext = {
  commands: { register: (definition) => { command = definition; return unregister; } },
  on: (event, listener) => {
    if (event === "dispose") dispose = listener as () => Promise<void>;
    return removeEvents;
  },
};
afterEach(async () => { await dispose?.(); dispose = undefined; command = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("首连失败不影响 dsh；只有人类配对命令启用观察，不把 token 写入命令结果", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(controlAssistant).mockRejectedValueOnce(new Error("请执行 /maneki pair")).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  await apply(context, { profileId: "work", showOnConnect: false });
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(command?.recordInput).toBe(false);
  const result = await command!.handler({ rawInput: " pair", signal: new AbortController().signal });
  expect(result.kind).toBe("success");
  expect(result.text).not.toContain("client-test-token");
  expect(controlAssistant).toHaveBeenCalledWith("pair", "work", expect.any(AbortSignal));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("root-token");
});

it("明确退出后不会自动重启 Runtime，卸载释放命令与事件订阅", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 202 }))));
  vi.mocked(controlAssistant).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  await apply(context, { showOnConnect: false });
  await vi.waitFor(() => expect(controlAssistant).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  vi.mocked(controlAssistant).mockResolvedValue({ state: "stopped" });
  const result = await command!.handler({ rawInput: "quit", signal: new AbortController().signal });
  expect(result.text).toContain("外部 dsh 任务可能继续");
  expect(controlAssistant).toHaveBeenCalledTimes(2);
  await dispose!(); dispose = undefined;
  expect(unregister).toHaveBeenCalledOnce();
  expect(removeEvents).toHaveBeenCalled();
  expect(controlAssistant).toHaveBeenCalledTimes(2);
});

it("非法命令、profile 与已取消请求不能到达管理入口", async () => {
  await expect(apply(context, { profileId: "../root" })).rejects.toThrow("profileId");
  vi.mocked(controlAssistant).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 202 }))));
  await apply(context, { showOnConnect: false });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect((await command!.handler({ rawInput: "exec rm", signal: new AbortController().signal })).kind).toBe("error");
  expect((await command!.handler({ rawInput: "pair", signal: AbortSignal.abort() })).kind).toBe("error");
  expect(controlAssistant).toHaveBeenCalledTimes(1);
});
