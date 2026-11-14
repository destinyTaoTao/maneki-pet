import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

import { connectEvents, ensureRuntime, getDnd, setDnd, syncRuntimeDnd, watchTrayDnd } from "./runtime-client";

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("缺安装的 native 启动错误原样传到界面，不假称后台会自动重试", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
  native.invoke.mockRejectedValue(new Error("Runtime 安装文件缺失，请重新安装小招"));
  await expect(ensureRuntime()).rejects.toThrow(/安装文件缺失/);
  expect(native.invoke).toHaveBeenCalledOnce();
});

it("勿扰写入被撤销或拒绝时明确失败，不能返回成功", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "revoked" }), { status: 401 })));
  await expect(setDnd("client", true)).rejects.toThrow(/401/);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
  await expect(getDnd("client")).rejects.toThrow(/403/);
});

it("托盘提交失败后回滚到已确认状态，并向界面报告错误", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await getDnd("client")).toBe(false);
  let click: (event: { payload: boolean }) => void = () => undefined;
  native.listen.mockImplementation(async (_name, handler) => { click = handler; return () => undefined; });
  native.invoke.mockResolvedValue(undefined);
  const onError = vi.fn();
  await watchTrayDnd("client", onError);
  click({ payload: true });
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(native.invoke).toHaveBeenCalledWith("sync_tray_dnd", { enabled: false });
});

it("共享事件直接更新回滚基线，旧读取和失败写入不能覆盖新状态", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: false }))));
  await getDnd("client");
  let finishRead: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finishRead = resolve; })));
  const oldRead = getDnd("client");
  native.invoke.mockResolvedValue(undefined);
  await syncRuntimeDnd(true);
  finishRead(new Response(JSON.stringify({ enabled: false })));
  expect(await oldRead).toBe(true);
  let click: (event: { payload: boolean }) => void = () => undefined;
  native.listen.mockImplementation(async (_name, handler) => { click = handler; return () => undefined; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "revoked" }), { status: 401 })));
  const onError = vi.fn();
  await watchTrayDnd("client", onError);
  click({ payload: false });
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(native.invoke).toHaveBeenLastCalledWith("sync_tray_dnd", { enabled: true });
});

it("过期鉴权连接的迟到 ready 不能登记展示实例", async()=>{
 vi.useFakeTimers();
 class Socket extends EventTarget {static instances:Socket[]=[];sent:string[]=[];closed=false;constructor(_url:string){super();Socket.instances.push(this);}send(value:string){this.sent.push(value);}close(){this.closed=true;this.dispatchEvent(new Event("close"));}}
 vi.stubGlobal("WebSocket",Socket);vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({ticket:"ticket"}))));
 const ready=vi.fn(),state=vi.fn();const stop=await connectEvents("fixture",()=>undefined,state,ready);
 for(let i=0;i<20;i++)await Promise.resolve();const stale=Socket.instances[0]!;stale.dispatchEvent(new Event("open"));vi.advanceTimersByTime(4001);
 stale.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"ready",connectionId:"old",runtimeEpoch:"old"})}));
 expect(ready).not.toHaveBeenCalled();expect(stale.closed).toBe(true);stop();vi.useRealTimers();
});
