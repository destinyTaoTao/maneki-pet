import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { controlAssistant, installedExecutable } from "./assistant-control.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function installation() {
  const dir = mkdtempSync(join(tmpdir(), "maneki-install-")); dirs.push(dir);
  vi.stubEnv("APPDATA", dir);
  const path = join(dir, "com.manekipet.desktop", "installation.json");
  mkdirSync(join(dir, "com.manekipet.desktop"));
  const executable = join(dir, "installed pet.exe"); writeFileSync(executable, "test fixture");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, protocolVersion: 1, executable }));
  return { path, executable };
}
it.skipIf(process.platform !== "win32")("只执行固定用户目录登记的绝对 exe，参数独立传入且不启用 shell", async () => {
  const { executable } = installation();
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => { callback!(null, '{"state":"ready","token":"client-token-that-is-at-least-32-characters"}', ""); return {} as ReturnType<typeof execFile>; });
  const signal = new AbortController().signal;
  const result = await controlAssistant("connect", "work", signal);
  expect(result.token).toBe("client-token-that-is-at-least-32-characters");
  expect(execFile).toHaveBeenCalledWith(executable, ["--assistant", "connect", "--client", "work"], { windowsHide: true, timeout: 120_000, maxBuffer: 16_384, signal }, expect.any(Function));
});
it.skipIf(process.platform !== "win32")("未登记、损坏描述和非法 profile 均不能启动任何进程", async () => {
  const { path } = installation();
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, protocolVersion: 1, executable: "relative.exe" }));
  expect(() => installedExecutable()).toThrow();
  rmSync(path);
  expect(() => installedExecutable()).toThrow();
  await expect(controlAssistant("pair", "../root", AbortSignal.timeout(1000))).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "win32")("原生错误只呈现固定诊断，不把响应或凭证内容送入 dsh 结果", async () => {
  installation();
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => { callback!(Object.assign(new Error("private process detail"), { cmd: "test command" }), '{"error":"private-root-value"}', "private stderr"); return {} as ReturnType<typeof execFile>; });
  await expect(controlAssistant("pair", "web", AbortSignal.timeout(1000))).rejects.toThrow("助手配置或凭证损坏");
});
