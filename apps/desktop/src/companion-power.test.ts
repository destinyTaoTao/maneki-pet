import { expect, it, vi } from "vitest";
import { CompanionPowerGuard } from "./companion-power.js";

it("invalidates an existing lease after a short suspend even when clocks do not reveal it", async () => {
  let generation = 1;
  const invalidate = vi.fn();
  const guard = new CompanionPowerGuard(async () => generation, invalidate);
  expect(await guard.check()).toBe(true);
  generation++;
  expect(await guard.check()).toBe(false);
  expect(invalidate).toHaveBeenCalledOnce();
  expect(await guard.check()).toBe(true);
});
it("rejects unavailable and out-of-order native observations", async () => {
  const pending: Array<(n:number)=>void> = [];
  const invalidate = vi.fn();
  const guard = new CompanionPowerGuard(() => new Promise(resolve => pending.push(resolve)), invalidate);
  const first = guard.check(); const second = guard.check();
  pending[1]!(2); expect(await second).toBe(true);
  pending[0]!(1); expect(await first).toBe(false);
  expect(invalidate).toHaveBeenCalledOnce();
  const unavailable = new CompanionPowerGuard(async () => { throw Error("unavailable"); }, invalidate);
  expect(await unavailable.check()).toBe(false);
});

it("does not admit visibility when suspend occurs during the native visibility query", async () => {
  let generation = 0;
  let finish: (visible: boolean) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const invalidate = vi.fn();
  const guard = new CompanionPowerGuard(async () => generation, invalidate);
  const pending = guard.checkVisible(() => new Promise(resolve => { finish = resolve; markStarted(); }));
  await started;
  generation++;
  finish(true);
  expect(await pending).toBe(false);
  expect(invalidate).toHaveBeenCalledOnce();
});

it("does not allow display when the page hides during the native visibility query", async () => {
  let pageVisible = true;
  let finish: (visible: boolean) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const guard = new CompanionPowerGuard(async () => 1, vi.fn());
  const pending = guard.checkVisible(() => new Promise(resolve => { finish = resolve; markStarted(); }), () => pageVisible);
  await started;
  pageVisible = false;
  finish(true);
  expect(await pending).toBe(false);
});
