import { fork, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const dirs: string[] = [];
const children: ChildProcess[] = [];
let worker: string;
function directory() { const dir = mkdtempSync(join(tmpdir(), "maneki-lock-进程 ")); dirs.push(dir); return dir; }
beforeAll(async () => {
  const dir = directory(); worker = join(dir, "worker.mjs");
  await build({ entryPoints: [join(import.meta.dirname, "../src/lifecycle.ts")], outfile: join(dir, "lifecycle.mjs"), bundle: true, format: "esm", platform: "node" });
  const native = join(import.meta.dirname, "../native/instance-lock/maneki-instance-lock.node");
  if (existsSync(native)) copyFileSync(native, join(dir, "maneki-instance-lock.node"));
  writeFileSync(worker, `import {InstanceLock} from './lifecycle.mjs';
import {createRequire} from 'node:module';
let lock;
if(process.argv[3]) {
const Native=createRequire(import.meta.url)('./maneki-instance-lock.node').NativeInstanceLock;
const native=new Native(process.argv[2]);
if(process.argv[3]==='partial-write')native.writeMetadata('{"pid":');
lock={acquire(){},release(){native.close(true)}};
} else lock=new InstanceLock(process.argv[2]);
process.on('message', m=>{if(m==='release'){lock.release(); process.send({state:'released'}); process.exit(0);}});
try {lock.acquire();process.send({state:'owner'});} catch(e) {lock.release();process.send({state:e.name==='LockBusyError'?'busy':'error',name:e.name});}
`);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
});
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function start(path: string, nativePhase?: string): Promise<{ child: ChildProcess; state: string }> {
  const child = fork(worker, [path, ...(nativePhase ? [nativePhase] : [])], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true }); children.push(child);
  const result = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("lock child exited before reply"); })]);
  return { child, state: (result[0] as { state: string }).state };
}
describe.skipIf(process.platform !== "win32")("OS instance lock — real processes", () => {
  it("失败进程 release 不能删除另一个进程的锁", async () => {
    const path = join(directory(), "runtime.lock");
    expect((await start(path)).state).toBe("owner");
    expect((await start(path)).state).toBe("busy");
    expect((await start(path)).state).toBe("busy");
  });
  it("12 个并发入口仅一位 owner，正常释放后下一位可启动", async () => {
    const path = join(directory(), "runtime.lock");
    const contenders = await Promise.all(Array.from({ length: 12 }, () => start(path)));
    const owners = contenders.filter((value) => value.state === "owner");
    expect(owners).toHaveLength(1);
    expect(contenders.filter((value) => value.state === "busy")).toHaveLength(11);
    const owner = owners[0]!.child;
    const exited = once(owner, "exit"); owner.send("release"); await exited;
    expect(existsSync(path)).toBe(false);
    expect((await start(path)).state).toBe("owner");
  });
  it("仅强杀本测试启动的 owner 后，保留元数据且自动恢复", async () => {
    const path = join(directory(), "runtime.lock");
    const { child, state } = await start(path); expect(state).toBe("owner");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect(existsSync(path)).toBe(true);
    expect((await start(path)).state).toBe("owner");
  });
  it("原生句柄已打开但尚未写入元数据时崩溃，空文件可恢复", async () => {
    const path = join(directory(), "runtime.lock");
    const { child, state } = await start(path, "before-write"); expect(state).toBe("owner");
    expect(readFileSync(path, "utf8")).toBe("");
    expect((await start(path)).state).toBe("busy");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect((await start(path)).state).toBe("owner");
  });
  it("非空半 JSON 记录在异常退出后仍保守拒绝，不伪称任意中断恢复", async () => {
    const path = join(directory(), "runtime.lock");
    const { child, state } = await start(path, "partial-write"); expect(state).toBe("owner");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect((await start(path)).state).toBe("error");
    expect(readFileSync(path, "utf8")).toBe('{"pid":');
  });
  it("内核句柄允许诊断读取，拒绝写入、删除和重命名", async () => {
    const path = join(directory(), "runtime.lock");
    expect((await start(path)).state).toBe("owner");
    expect(JSON.parse(readFileSync(path, "utf8")).osLockVersion).toBe(1);
    expect(() => writeFileSync(path, "replace")).toThrow();
    expect(() => unlinkSync(path)).toThrow();
    expect(() => renameSync(path, `${path}.renamed`)).toThrow();
  });
  it("同一文件的大小写及硬链接别名不能绕过排他", async () => {
    const path = join(directory(), "runtime.lock");
    const alias = `${path}.alias`; writeFileSync(path, ""); linkSync(path, alias);
    expect((await start(path)).state).toBe("owner");
    expect((await start(path.toUpperCase())).state).toBe("busy");
    expect((await start(alias)).state).toBe("busy");
  });
  it("不同配置目录可以同时持锁", async () => {
    const results = await Promise.all([start(join(directory(), "runtime.lock")), start(join(directory(), "runtime.lock"))]);
    expect(results.map((value) => value.state)).toEqual(["owner", "owner"]);
  });
  it("旧版存活 PID 记录保留，旧版死 PID 可恢复，新版残留不受 PID 复用阻塞", async () => {
    const path = join(directory(), "runtime.lock");
    const legacy = JSON.stringify({ pid: process.pid, heldSince: "2026-01-01T00:00:00Z" });
    writeFileSync(path, legacy);
    expect((await start(path)).state).toBe("busy");
    expect(readFileSync(path, "utf8")).toBe(legacy);
    writeFileSync(path, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, heldSince: "2026-01-01T00:00:00Z" }));
    const recovered = await start(path); expect(recovered.state).toBe("owner");
    const exited = once(recovered.child, "exit"); recovered.child.send("release"); await exited;
    writeFileSync(path, JSON.stringify({ pid: process.pid, heldSince: "2026-01-01T00:00:00Z", osLockVersion: 1 }));
    expect((await start(path)).state).toBe("owner");
  });
});
