/**
 * 崩溃锁回收的确定性交错探针（不加入测试门禁）：
 *   corepack pnpm --filter @maneki-pet/runtime build
 *   node packages/runtime/tests/fixtures/instance-lock-recovery-race.mjs
 *
 * 仅使用临时目录；在当前进程内替换 unlinkSync，模拟两个进程的调度顺序：
 * A 已确认旧持有者死亡 → B 回收旧锁且获取新锁 → A 删除路径上的 B 新锁。
 * 两个 acquire 都返回则证明该交错未被拒绝；这不测量竞态在实机的发生概率。
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLock } from "../../dist/lifecycle.js";

const directory = fs.mkdtempSync(join(tmpdir(), "maneki-lock-recovery-review-"));
const lockPath = join(directory, "runtime.lock");
const originalUnlink = fs.unlinkSync;
let interleaved = false;
let secondAcquired = false;
let firstAcquired = false;
try {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, heldSince: "synthetic-crash" }));
  const first = new InstanceLock(lockPath);
  const second = new InstanceLock(lockPath);
  fs.unlinkSync = (path) => {
    if (path === lockPath && !interleaved) {
      interleaved = true;
      second.acquire();
      secondAcquired = true;
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  first.acquire();
  firstAcquired = true;
} finally {
  fs.unlinkSync = originalUnlink;
  syncBuiltinESMExports();
  if (fs.existsSync(lockPath)) originalUnlink(lockPath);
  fs.rmdirSync(directory);
}
console.log(JSON.stringify({ firstAcquired, secondAcquired, concurrentOwners: firstAcquired && secondAcquired }));
