import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InstanceLock, LockBusyError, RuntimeLifecycle } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("InstanceLock 单实例锁", () => {
  it("已取得 OS 排他权限时可恢复空文件，其他损坏记录仍保守拒绝", () => {
    const path = join(makeTempDir(), "runtime.lock");
    writeFileSync(path, "");
    const lock = new InstanceLock(path);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
    writeFileSync(path, JSON.stringify({ pid: "invalid", heldSince: "now" }));
    expect(() => new InstanceLock(path).acquire()).toThrow("unverified owner");
  });
  it("首次获取成功，重复获取被拒绝并报告存活持有者", () => {
    const lockPath = join(makeTempDir(), "runtime.lock");
    const first = new InstanceLock(lockPath);
    first.acquire();
    const second = new InstanceLock(lockPath);
    try {
      second.acquire();
      expect.unreachable("second acquire should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LockBusyError);
      const busy = error as LockBusyError;
      expect(busy.holder.pid).toBe(process.pid);
      expect(isNaN(Date.parse(busy.holder.heldSince))).toBe(false);
    }
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });

  it("崩溃残留的死进程锁被回收", () => {
    const dir = makeTempDir();
    const lockPath = join(dir, "runtime.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, heldSince: "2026-01-01T00:00:00Z" }));
    const lock = new InstanceLock(lockPath);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });
  it.each(["EPERM", "EIO", undefined])("旧 PID 检查出现 %s 时保守拒绝且保留原记录", (code) => {
    const path = join(makeTempDir(), "runtime.lock");
    const legacy = JSON.stringify({ pid: process.pid, heldSince: "2026-01-01T00:00:00Z" });
    writeFileSync(path, legacy);
    // 仅验证旧版 PID 兼容分支的异常语义；OS 原子性另由真实多进程测试证明。
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("probe failed"), { code }); });
    const lock = new InstanceLock(path);
    expect(() => lock.acquire()).toThrow(LockBusyError);
    lock.release();
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });
  it("旧 PID 仅在 ESRCH 明确不存在时回收", () => {
    const path = join(makeTempDir(), "runtime.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, heldSince: "2026-01-01T00:00:00Z" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); });
    const lock = new InstanceLock(path);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });
  it("超过 4 KiB 的元数据拒绝，失败释放保留原记录", () => {
    const path = join(makeTempDir(), "runtime.lock"); const raw = "x".repeat(4097); writeFileSync(path, raw);
    const lock = new InstanceLock(path);
    expect(() => lock.acquire()).toThrow("exceeds 4 KiB");
    lock.release(); expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("release 后锁文件移除", () => {
    const dir = makeTempDir();
    const lockPath = join(dir, "runtime.lock");
    const lock = new InstanceLock(lockPath);
    lock.acquire();
    lock.release();
    const second = new InstanceLock(lockPath);
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });
});

describe("RuntimeLifecycle 状态机", () => {
  it("合法路径 stopped→starting→ready→stopping→stopped", () => {
    const lifecycle = new RuntimeLifecycle();
    expect(lifecycle.state).toBe("stopped");
    lifecycle.transition("starting");
    lifecycle.transition("ready");
    lifecycle.transition("stopping");
    expect(lifecycle.transition("stopped")).toBe("stopped");
  });

  it("非法迁移被拒绝", () => {
    const lifecycle = new RuntimeLifecycle();
    expect(() => lifecycle.transition("ready")).toThrow("invalid runtime state transition: stopped -> ready");
  });
});
