/**
 * 崩溃锁回收的独立多进程探针（完整门禁见 instance-lock-process.test.ts）：
 *   corepack pnpm --filter @maneki-pet/runtime build
 *   node packages/runtime/tests/fixtures/instance-lock-recovery-race.mjs
 *
 * 仅使用本次创建的临时目录及子进程。旧版 unlink 交错复现保存在本文件的
 * Git 历史中；当前探针用真实 OS 排他验证竞争与失败 release，不替换 fs API。
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLock, LockBusyError } from "../../dist/lifecycle.js";

if (process.argv[2] === "worker") {
  const lock = new InstanceLock(process.argv[3]);
  process.on("message", () => { lock.release(); process.exit(0); });
  try { lock.acquire(); process.send({ acquired: true }); }
  catch (error) {
    lock.release();
    if (!(error instanceof LockBusyError)) throw error;
    process.send({ acquired: false });
  }
} else {
  const directory = mkdtempSync(join(tmpdir(), "maneki-lock-recovery-review-"));
  const lockPath = join(directory, "runtime.lock");
  const children = [];
  let recovered;
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, heldSince: "synthetic-crash" }));
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const child = fork(import.meta.filename, ["worker", lockPath], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });
      children.push(child);
      const [result] = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => { throw new Error("lock worker exited before reply"); }),
      ]);
      return { child, acquired: result.acquired };
    }));
    const owners = results.filter((result) => result.acquired);
    assert.equal(owners.length, 1, "exactly one process must own the lock");
    // 全部失败对象均已 release；owner 仍必须保持排他。
    const probe = new InstanceLock(lockPath);
    assert.throws(() => probe.acquire(), LockBusyError);
    probe.release();
    await Promise.all(children.map(async (child) => { const exited = once(child, "exit"); child.send("release"); await exited; }));
    assert.equal(existsSync(lockPath), false);
    recovered = new InstanceLock(lockPath); recovered.acquire(); recovered.release();
    console.log(JSON.stringify({ contenders: results.length, owners: owners.length, failedReleasePreservedOwner: true, recoveredAfterRelease: true }));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    }
    recovered?.release();
    rmSync(directory, { recursive: true, force: true });
  }
}
