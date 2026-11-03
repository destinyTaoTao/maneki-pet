import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

import { getDnd, setDnd, syncRuntimeDnd, watchTrayDnd } from "./runtime-client";

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

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
