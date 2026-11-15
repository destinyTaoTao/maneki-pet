import { closeSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeState = "stopped" | "starting" | "ready" | "degraded" | "stopping";

const ALLOWED_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  stopped: ["starting"],
  starting: ["ready", "degraded", "stopping"],
  ready: ["degraded", "stopping"],
  degraded: ["ready", "stopping"],
  stopping: ["stopped"],
};

/** 运行时状态机：非法迁移被拒绝并保留原状态。 */
export class RuntimeLifecycle {
  private currentState: RuntimeState = "stopped";

  get state(): RuntimeState {
    return this.currentState;
  }

  transition(next: RuntimeState): RuntimeState {
    if (!ALLOWED_TRANSITIONS[this.currentState].includes(next)) {
      throw new Error(`invalid runtime state transition: ${this.currentState} -> ${next}`);
    }
    this.currentState = next;
    return this.currentState;
  }
}

export interface LockHolder {
  pid: number;
  heldSince: string;
  osLockVersion?: 1;
}

export class LockBusyError extends Error {
  readonly holder: LockHolder;

  constructor(holder: LockHolder) {
    super(`runtime instance lock is held by pid ${holder.pid} since ${holder.heldSince}; a user config dir allows one runtime`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

/**
 * 单实例锁（architecture §6.2/§2.3）：一个用户配置目录只允许一个 Runtime，
 * 双入口并发启动第二个必须明确失败；持有进程已死亡（崩溃残留）时回收残锁。
 */
export class InstanceLock {
  private handle: NativeLock | undefined;
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (this.handle) throw new LockBusyError({ pid: process.pid, heldSince: "already acquired" });
    const NativeInstanceLock = loadNativeLock();
    let handle: NativeLock;
    try {
      handle = new NativeInstanceLock(this.lockPath);
    } catch (error) {
      if (error instanceof Error && error.message.includes("MANEKI_INSTANCE_LOCK_BUSY")) {
        // 创建中可能尚无有效元数据；OS 排他结果本身就是 busy，不能再按 PID 删除。
        throw new LockBusyError(readDiagnosticHolder(this.lockPath) ?? { pid: 0, heldSince: "metadata pending" });
      }
      throw error;
    }
    try {
      const raw = handle.readMetadata();
      const holder = parseHolder(raw);
      if (raw.length > 0 && !holder) throw new Error("instance lock metadata unavailable; refusing to replace an unverified owner");
      // 旧版未持内核句柄，仍须保护其活跃 PID；新版句柄已取得说明旧 owner 已退出。
      if (holder && holder.osLockVersion !== 1 && isPidAlive(holder.pid)) throw new LockBusyError(holder);
      handle.writeMetadata(JSON.stringify({ pid: process.pid, heldSince: new Date().toISOString(), osLockVersion: 1 } satisfies LockHolder));
      this.handle = handle;
    } catch (error) {
      handle.close(false);
      throw error;
    }
  }

  release(): void {
    this.handle?.close(true);
    this.handle = undefined;
  }
}

interface NativeLock {
  readMetadata(): string;
  writeMetadata(metadata: string): void;
  close(remove: boolean): void;
}
function loadNativeLock(): new (path: string) => NativeLock {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("instance lock unsupported: Windows x64 native implementation required");
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname(modulePath);
  // 源码/dist 与单文件发行入口固定布局；不接受环境变量或工作目录指定原生代码。
  const path = join(moduleDir, /^lifecycle\.[jt]s$/.test(basename(modulePath)) ? "../native/instance-lock/maneki-instance-lock.node" : "maneki-instance-lock.node");
  try {
    return (createRequire(import.meta.url)(path) as { NativeInstanceLock: new (path: string) => NativeLock }).NativeInstanceLock;
  } catch (error) {
    throw new Error("instance lock native binding unavailable; rebuild the Runtime for Windows x64 (no PID-lock fallback)", { cause: error });
  }
}

function parseHolder(raw: string): LockHolder | null {
  try {
    const holder = JSON.parse(raw) as Partial<LockHolder> | null;
    return holder && typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0 && typeof holder.heldSince === "string" && (holder.osLockVersion === undefined || holder.osLockVersion === 1) ? holder as LockHolder : null;
  } catch { return null; }
}

function readDiagnosticHolder(path: string): LockHolder | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return count <= 4096 ? parseHolder(bytes.subarray(0, count).toString("utf8")) : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function isPidAlive(pid: number): boolean {
  if (pid > 0xffff_ffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 或其他无法核验的状态保守视为存活，不能删除旧版 owner 的记录。
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
