import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopCredentialError, openAdminSession } from "./admin-session.js";
import { InstanceLock } from "./lifecycle.js";
export { DesktopCredentialError } from "./admin-session.js";

/** 仅供 native 管理入口；固定回环地址，不启动 Runtime 或打开数据库。 */
export async function desktopCredential(configDir: string, port: number): Promise<{ token: string }> {
  return clientCredential(configDir, port, "desktop-client", "desktop-shell", "express,notify,settings", true);
}

export async function clientCredential(configDir: string, port: number, fileId: string, name: string, scopes: string, allowPair: boolean): Promise<{ token: string }> {
  const session = await openAdminSession(configDir, port);
  // 管理入口并发配对也串行；残锁由现有 PID 存活检查回收。
  const lock = new InstanceLock(join(configDir, `${fileId}.lock`));
  try { lock.acquire(); } catch { throw new DesktopCredentialError("pairing_busy"); }
  const path = join(configDir, `${fileId}.json`);
  const pending = `${path}.pending`;
  try {
    if (existsSync(path)) {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new DesktopCredentialError("invalid_config"); }
      if (typeof saved !== "object" || saved === null || !("instanceId" in saved) || saved.instanceId !== session.instanceId || !("token" in saved) || typeof saved.token !== "string") {
        throw new DesktopCredentialError("invalid_config");
      }
      const probe = await session.request("/v1/limits", undefined, saved.token);
      if (probe.status !== 200) throw new DesktopCredentialError("credential_rejected");
      return { token: saved.token };
    }
    if (!allowPair) throw new DesktopCredentialError("pairing_required");
    const pair = await session.request("/v1/pair", { name, scopes });
    if (pair.status !== 200 || typeof pair.body?.token !== "string" || typeof pair.body?.clientId !== "string") {
      throw new DesktopCredentialError("pairing_failed");
    }
    writeFileSync(pending, JSON.stringify({ instanceId: session.instanceId, clientId: pair.body.clientId, token: pair.body.token }), { mode: 0o600 });
    renameSync(pending, path);
    return { token: pair.body.token };
  } finally {
    rmSync(pending, { force: true });
    lock.release();
  }
}
