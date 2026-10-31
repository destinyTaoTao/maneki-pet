import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

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
}

export class LockBusyError extends Error {
  readonly holder: LockHolder;

  constructor(holder: LockHolder) {
    super(`runtime instance lock is held by pid ${holder.pid} (alive) since ${holder.heldSince}; a user config dir allows one runtime`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

/**
 * 单实例锁（architecture §6.2/§2.3）：一个用户配置目录只允许一个 Runtime，
 * 双入口并发启动第二个必须明确失败；持有进程已死亡（崩溃残留）时回收残锁。
 */
export class InstanceLock {
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (existsSync(this.lockPath)) {
      const holder = this.readHolder();
      if (holder && isPidAlive(holder.pid)) {
        throw new LockBusyError(holder);
      }
      // 崩溃残留：持有者已死亡，回收残锁后重试一次。
      unlinkSync(this.lockPath);
    }
    try {
      const fd = openSync(this.lockPath, "wx");
      const payload = JSON.stringify({ pid: process.pid, heldSince: new Date().toISOString() } satisfies LockHolder);
      writeSync(fd, payload);
      closeSync(fd);
    } catch (error) {
      if (isEexist(error)) {
        const holder = this.readHolder();
        if (holder && isPidAlive(holder.pid)) {
          throw new LockBusyError(holder);
        }
        unlinkSync(this.lockPath);
        return this.acquire();
      }
      throw error;
    }
  }

  release(): void {
    if (existsSync(this.lockPath)) {
      unlinkSync(this.lockPath);
    }
  }

  private readHolder(): LockHolder | null {
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8")) as LockHolder;
    } catch {
      return null;
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
