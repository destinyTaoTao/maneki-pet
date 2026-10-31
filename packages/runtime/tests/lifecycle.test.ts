import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InstanceLock, LockBusyError, RuntimeLifecycle } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("InstanceLock 单实例锁", () => {
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

  it("release 后锁文件移除", () => {
    const dir = makeTempDir();
    const lockPath = join(dir, "runtime.lock");
    const lock = new InstanceLock(lockPath);
    lock.acquire();
    lock.release();
    expect(() => new InstanceLock(lockPath).acquire()).not.toThrow();
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
