import { afterEach, expect, it, vi } from "vitest";
import { VoiceController, type VoiceResult } from "./voice-controller.js";
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup(recognized?: (text: string) => void) {
  const capture = {
    start: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const player = { play: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const call = vi.fn<(path: string) => Promise<unknown>>(
    async (path: string) =>
      path === "/voice/acquire"
        ? { leaseId: "lease", ttlMs: 8000 }
        : path === "/voice/renew"
          ? { ttlMs: 8000 }
          : path === "/voice/transcribe"
            ? {
                requestId: "request",
                status: "recognized",
                code: null,
                transcript: "待办：买牛奶",
              }
            : path === "/voice/submit"
              ? {
                  requestId: "request",
                  status: "submitted",
                  code: null,
                  transcript: "待办：买牛奶",
                }
              : {},
  );
  const submitted = vi.fn(),
    error = vi.fn(),
    controller = new VoiceController({
      capture: () => capture,
      player,
      transport: { call: <T>(path: string) => call(path) as Promise<T> },
      submitted,
      error,
      changed: vi.fn(),
      ...(recognized ? { recognized } : {}),
      uuid: () => "request",
    });
  return { capture, player, call, submitted, error, controller };
}
afterEach(() => vi.useRealTimers());
it("转写返回后仍须当前轮次有效才提交，取消候选不会发送确认请求", async () => {
  let stop = () => undefined;
  const { controller, call, submitted } = setup(() => stop());
  stop = () => {
    void controller.cancel(false);
  };
  await controller.start();
  controller.stopIfOwned("old-lease");
  expect(controller.state()).toBe("recording");
  await controller.finish();
  expect(submitted).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([path]) => path === "/voice/submit")).toBe(
    false,
  );
});
it("权限等待期间松开立即取消，迟到的设备就绪不能转写或提交", async () => {
  const { controller, capture, call, submitted } = setup();
  let ready: () => void = () => undefined;
  capture.start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const pending = controller.start();
  await flush();
  expect(controller.state()).toBe("starting");
  await controller.finish();
  expect(capture.cancel).toHaveBeenCalled();
  ready();
  await pending;
  expect(controller.state()).toBe("idle");
  expect(submitted).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([path]) => path === "/voice/transcribe")).toBe(
    false,
  );
});
it("释放先于租约返回时不申请麦克风，迟到租约只释放", async () => {
  const { controller, capture, call } = setup();
  let grant: (value: { leaseId: string; ttlMs: number }) => void = () =>
    undefined;
  call.mockImplementation((path) =>
    path === "/voice/acquire"
      ? new Promise((resolve) => {
          grant = resolve;
        })
      : Promise.resolve({}),
  );
  const pending = controller.start();
  await flush();
  await controller.finish();
  grant({ leaseId: "lease", ttlMs: 8000 });
  await pending;
  expect(capture.start).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([path]) => path === "/voice/release")).toBe(
    true,
  );
});
it("停止播放后才开麦，麦克风关闭后才上传，迟到转写在取消后不提交", async () => {
  const { controller, capture, player, call, submitted } = setup();
  let reply: (value: VoiceResult) => void = () => undefined;
  call.mockImplementation((path) =>
    path === "/voice/transcribe"
      ? new Promise((resolve) => {
          reply = resolve;
        })
      : Promise.resolve({ leaseId: "lease", ttlMs: 8000 }),
  );
  await controller.start();
  expect(player.stop.mock.invocationCallOrder[0]).toBeLessThan(
    capture.start.mock.invocationCallOrder[0]!,
  );
  const pending = controller.finish();
  await flush();
  expect(capture.finish).toHaveBeenCalledOnce();
  expect(controller.state()).toBe("transcribing");
  await controller.cancel();
  reply({
    requestId: "request",
    status: "submitted",
    code: null,
    transcript: "迟到",
  });
  await pending;
  expect(submitted).not.toHaveBeenCalled();
});
it("续租一直无响应时本地截止仍关闭设备，不等网络请求完成", async () => {
  vi.useFakeTimers();
  const { controller, capture, call, error } = setup();
  call.mockImplementation((path) =>
    path === "/voice/renew"
      ? new Promise(() => undefined)
      : Promise.resolve({ leaseId: "lease", ttlMs: 8000 }),
  );
  await controller.start();
  expect(controller.state()).toBe("recording");
  await vi.advanceTimersByTimeAsync(7950);
  expect(controller.state()).toBe("idle");
  expect(capture.cancel).toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("voice_lease_expired");
});
it("同一轮成功转写只通知一次，关闭后不自动续租", async () => {
  vi.useFakeTimers();
  const { controller, submitted, call } = setup();
  await controller.start();
  await controller.finish();
  await controller.finish();
  expect(submitted).toHaveBeenCalledOnce();
  await controller.complete();
  const count = call.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(call.mock.calls.length).toBe(count);
});
