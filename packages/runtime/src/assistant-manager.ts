import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopCredentialError, openAdminSession } from "./admin-session.js";
import { clientCredential } from "./desktop-credential.js";
import { InstanceLock, LockBusyError } from "./lifecycle.js";

export const assistantActions = ["connect", "pair", "status", "show", "assistant", "quit"] as const;
export type AssistantAction = typeof assistantActions[number];

/** 此模式由本安装原生入口调用；不打开数据库，不把 root 返回调用端。 */
export async function manageAssistant(configDir: string, port: number, cli: string, action: AssistantAction, client: string): Promise<{ state: "ready" | "stopped"; token?: string }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(client) || !assistantActions.includes(action) || !Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopCredentialError("invalid_config");
  mkdirSync(configDir, { recursive: true });
  const lock = new InstanceLock(join(configDir, "assistant-manager.lock"));
  const until = Date.now() + 15_000;
  for (;;) {
    try { lock.acquire(); break; }
    catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= until) throw new DesktopCredentialError("pairing_busy");
      await delay(50);
    }
  }
  try {
    let session;
    try { session = await openAdminSession(configDir, port); }
    catch (error) {
      const missingRoot = !existsSync(join(configDir, "root-token"));
      const offline = error instanceof DesktopCredentialError && error.code === "runtime_unavailable";
      if (!missingRoot && !offline) throw error;
      if (action === "status" || action === "quit") {
        if (existsSync(join(configDir, "runtime.lock"))) throw new DesktopCredentialError("runtime_unavailable");
        return { state: "stopped" };
      }
      // 固定使用调用此管理模式的已安装 sidecar 与 bundle，不执行插件提供的命令。
      const child = spawn(process.execPath, [cli, "--config-dir", configDir, "--port", String(port), "--origin-allowlist", "http://tauri.localhost", "--background"], { detached: true, windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      const readyBy = Date.now() + 10_000;
      for (;;) {
        try { session = await openAdminSession(configDir, port); break; }
        catch (startError) {
          if (startError instanceof DesktopCredentialError && ["identity_mismatch", "protocol_mismatch"].includes(startError.code)) throw startError;
          if (Date.now() >= readyBy) throw new DesktopCredentialError("runtime_unavailable");
          await delay(100);
        }
      }
    }
    if (action === "quit") {
      const result = await session.request("/v1/shutdown", {});
      if (result.status !== 200 || result.body.stopping !== true) throw new DesktopCredentialError("runtime_unavailable");
      const stoppedBy = Date.now() + 10_000;
      while (existsSync(join(configDir, "runtime.lock"))) {
        if (Date.now() >= stoppedBy) throw new DesktopCredentialError("timeout");
        await delay(50);
      }
      return { state: "stopped" };
    }
    if (action === "status" || action === "show" || action === "assistant") return { state: "ready" };
    const credential = await clientCredential(configDir, port, `dsh-client-${client}`, `dsh-${client}`, "express", action === "pair");
    return { state: "ready", token: credential.token };
  } finally { lock.release(); }
}
