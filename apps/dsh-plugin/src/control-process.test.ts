import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runControlProcess } from "./control-process.js";

it("管理入口退出并给出完整回执后，后台继承的管道不阻塞返回", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-control-pipe-"));
  const release = join(directory, "release");
  const descendant = `
    const fs = require('node:fs');
    const timer = setInterval(() => {
      if (fs.existsSync(process.argv[1])) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 50);
    setTimeout(() => process.exit(0), 10000).unref();
  `;
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], {
      detached: true, windowsHide: true, stdio: ['ignore', 1, 2],
    });
    child.unref();
    process.stdout.write('{"state":"ready"}\\n');
    process.exit(0);
  `;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runControlProcess(process.execPath, ["-e", parent, release], new AbortController().signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("native process exited but inherited pipe blocked response")), 2000);
      }),
    ]);
    expect(JSON.parse(result)).toEqual({ state: "ready" });
  } finally {
    clearTimeout(timeout);
    writeFileSync(release, "release test descendant");
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("超过回执上限时终止本次管理入口，诊断不包含进程输出", async () => {
  await expect(runControlProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(16385));setTimeout(()=>{},10000)"], new AbortController().signal))
    .rejects.toThrow("native_control_failed");
});

it("取消管理入口时拒绝结果并释放直接子进程", async () => {
  const controller = new AbortController();
  const result = runControlProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow("native_control_failed");
});

it("完整的无换行回执在输出结束后也可返回", async () => {
  const result = await runControlProcess(process.execPath, ["-e", "process.stdout.write('{\"error\":\"user_denied\"}');process.exitCode=1"], new AbortController().signal);
  expect(JSON.parse(result)).toEqual({ error: "user_denied" });
});
