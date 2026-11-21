import { afterEach, expect, it, vi } from "vitest";
import { apply, type DshPluginContext } from "./index.js";
import { controlAssistant } from "./assistant-control.js";
import type { DshSessionEvent } from "@maneki-pet/adapter-dsh";
vi.mock("./assistant-control.js", () => ({ controlAssistant: vi.fn() }));

type Command = Parameters<DshPluginContext["commands"]["register"]>[0];
let dispose: (() => Promise<void>) | undefined;
let command: Command | undefined;
let sessionListener: ((session: { id: string; header?: { cwd?: string } }, event: DshSessionEvent["event"]) => void) | undefined;
const unregister = vi.fn();
const removeEvents = vi.fn();
const context: DshPluginContext = {
  commands: { register: (definition) => { command = definition; return unregister; } },
  on: (event, listener) => {
    if (event === "dispose") dispose = listener as () => Promise<void>;
    else sessionListener = listener as NonNullable<typeof sessionListener>;
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

it("上报保留 A 等待与 B 终态，定位只包含目录名，卸载标记来源失联", async () => {
  const reports: Array<{ connected: boolean; sessions: Array<{ sessionId: string; phase: string; projectName: string }> }> = [];
  vi.mocked(controlAssistant).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, options) => {
    if (String(url).endsWith("/observations/sessions")) reports.push(JSON.parse(options.body));
    return new Response(null, { status: 202 });
  }));
  await apply(context, { showOnConnect: false });
  await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0));
  const emit = (id: string, seq: number, type: string, data: Record<string, unknown>) =>
    sessionListener!({ id, header: { cwd: `C:\\private-parent\\project-${id}` } }, { seq, type, data });
  emit("A", 0, "turn/start", { turn: 1 });
  emit("A", 1, "tool/call", { turn: 1, name: "ask_user_question" });
  emit("B", 0, "turn/start", { turn: 1 });
  emit("B", 1, "turn/end", { turn: 1, reason: { kind: "completed" } });
  await vi.waitFor(() => expect(reports.at(-1)?.sessions.map((row) => row.phase)).toEqual(["waiting_input", "completed"]));
  expect(reports.at(-1)?.sessions[0]?.projectName).toBe("project-A");
  expect(JSON.stringify(reports)).not.toContain("private-parent");
  sessionListener!({ id: "C" }, { seq: 0, type: "turn/start", data: { turn: 1 } });
  await vi.waitFor(() => expect(reports.at(-1)?.sessions.find((row) => row.sessionId === "C")?.projectName).toBe(""));
  emit("B", 1, "step/start", { turn: 1 });
  await dispose!(); dispose = undefined;
  expect(reports.at(-1)?.connected).toBe(false);
  expect(reports.at(-1)?.sessions.map((row) => row.phase)).toEqual(["waiting_input", "completed", "working"]);
});

it("容量满时淘汰最早完成的 B，保留先启动但最近才完成的 A", async () => {
  const snapshots: Array<{ sessions: Array<{ sessionId: string; phase: string }> }> = [];
  vi.mocked(controlAssistant).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, options) => {
    if (String(url).endsWith("/observations/sessions")) snapshots.push(JSON.parse(options.body));
    return new Response(null, { status: 202 });
  }));
  await apply(context, { showOnConnect: false });
  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
  const emit = (id: string, seq: number, type: string, data: Record<string, unknown>) => sessionListener!({ id }, { seq, type, data });
  emit("A", 0, "turn/start", { turn: 1 });
  emit("B", 0, "turn/start", { turn: 1 });
  emit("B", 1, "turn/end", { turn: 1, reason: { kind: "completed" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  emit("A", 1, "turn/end", { turn: 1, reason: { kind: "completed" } });
  for (let index = 0; index < 63; index++) emit(`new-${index}`, 0, "turn/start", { turn: 1 });
  await vi.waitFor(() => {
    expect(snapshots.at(-1)?.sessions).toHaveLength(64);
    expect(snapshots.at(-1)?.sessions.some((row) => row.sessionId === "A")).toBe(true);
    expect(snapshots.at(-1)?.sessions.some((row) => row.sessionId === "B")).toBe(false);
  });
});

it("旧 Runtime 缺少会话路由时仍发送原表情，并提示版本能力", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(controlAssistant).mockResolvedValue({ state: "ready", token: "client-test-token-that-is-long-enough" });
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url) => {
    urls.push(String(url));
    return new Response(null, { status: String(url).endsWith("/observations/sessions") ? 404 : 202 });
  }));
  await apply(context, { showOnConnect: false });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("状态表情继续联动")));
  expect(urls.some((url) => url.endsWith("/expressions/state"))).toBe(true);
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

it("人类 assistant 命令仅唤起原生面板，不向 dsh 返回个人凭证",async()=>{
  vi.mocked(controlAssistant).mockResolvedValue({state:"ready",token:"observer-client-token-that-is-long-enough"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(null,{status:202})));
  await apply(context,{showOnConnect:false});await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());
  await new Promise<void>(resolve=>setImmediate(resolve));
  const result=await command!.handler({rawInput:"assistant",signal:new AbortController().signal});
  expect(controlAssistant).toHaveBeenLastCalledWith("assistant","web",expect.any(AbortSignal));expect(result.kind).toBe("success");expect(result.text).not.toContain("token");
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
