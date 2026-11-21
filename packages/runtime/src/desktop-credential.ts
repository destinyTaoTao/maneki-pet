import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopCredentialError, openAdminSession } from "./admin-session.js";
import { InstanceLock } from "./lifecycle.js";
import { BRIEFING_SCOPE, REMINDER_CANCEL_SCOPE, REMINDER_READ_SCOPE, REMINDER_RESCHEDULE_SCOPE, REMINDER_SCOPE } from "./auth.js";
export { DesktopCredentialError } from "./admin-session.js";

/** 仅供 native 管理入口；固定回环地址，不启动 Runtime 或打开数据库。 */
export async function desktopCredential(configDir: string, port: number): Promise<{ token: string }> {
  return clientCredential(configDir, port, "desktop-client", "desktop-shell", "express,notify,settings", true);
}

export async function clientCredential(configDir: string, port: number, fileId: string, name: string, scopes: string, allowPair: boolean): Promise<{ token: string; clientId: string }> {
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
      if (typeof saved !== "object" || saved === null || !("instanceId" in saved) || saved.instanceId !== session.instanceId || !("token" in saved) || typeof saved.token !== "string" || !("clientId" in saved) || typeof saved.clientId !== "string" || !/^client-[0-9a-f]{12}$/.test(saved.clientId)) {
        throw new DesktopCredentialError("invalid_config");
      }
      const probe = await session.request(credentialProbe(scopes), undefined, saved.token);
      const named = Object.hasOwn(namedIdentityRoutes, scopes);
      if (probe.status !== 200 || (named && (probe.body.clientId !== saved.clientId || probe.body.name !== name))) {
        throw new DesktopCredentialError("credential_rejected");
      }
      return { token: saved.token, clientId: saved.clientId };
    }
    if (!allowPair) throw new DesktopCredentialError("pairing_required");
    const pair = await session.request("/v1/pair", { name, scopes });
    if (pair.status !== 200 || typeof pair.body?.token !== "string" || typeof pair.body?.clientId !== "string") {
      throw new DesktopCredentialError("pairing_failed");
    }
    writeFileSync(pending, JSON.stringify({ instanceId: session.instanceId, clientId: pair.body.clientId, token: pair.body.token }), { mode: 0o600 });
    renameSync(pending, path);
    return { token: pair.body.token, clientId: pair.body.clientId };
  } finally {
    rmSync(pending, { force: true });
    lock.release();
  }
}

const namedIdentityRoutes: Readonly<Record<string, string>> = {
  [BRIEFING_SCOPE]: "/v1/briefing/identity",
  [REMINDER_SCOPE]: "/v1/reminders/identity",
  [REMINDER_READ_SCOPE]: "/v1/reminders/read/identity",
  [REMINDER_CANCEL_SCOPE]: "/v1/reminders/cancel/identity",
  [REMINDER_RESCHEDULE_SCOPE]: "/v1/reminders/reschedule/identity",
};

function credentialProbe(scopes: string): string {
  if (Object.hasOwn(namedIdentityRoutes, scopes)) return namedIdentityRoutes[scopes]!;
  if (scopes === "speech_host") return "/v1/speech-host/identity";
  if (scopes.split(",").includes("assistant")) return "/v1/assistant/settings";
  return "/v1/limits";
}
