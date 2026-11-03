import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { InstanceLock } from "./lifecycle.js";

/** 仅供 native 管理入口；固定回环地址，不启动 Runtime 或打开数据库。 */
export async function desktopCredential(configDir: string, port: number): Promise<{ token: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid runtime port");
  const base = `http://127.0.0.1:${port}`;
  const json = async (path: string, token?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid runtime response");
    return { status: response.status, body: value as Record<string, unknown> };
  };
  const health = await json("/v1/health");
  if (health.status !== 200 || health.body?.protocolVersion !== 1 || typeof health.body?.instanceId !== "string") {
    throw new Error("runtime protocol incompatible; no pairing performed");
  }
  // 管理入口并发配对也串行；残锁由现有 PID 存活检查回收。
  const lock = new InstanceLock(join(configDir, "desktop-client.lock"));
  lock.acquire();
  const path = join(configDir, "desktop-client.json");
  const pending = `${path}.pending`;
  try {
    if (existsSync(path)) {
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof saved !== "object" || saved === null || !("instanceId" in saved) || saved.instanceId !== health.body.instanceId || !("token" in saved) || typeof saved.token !== "string") {
        throw new Error("desktop credential belongs to another runtime or is invalid; trusted re-pairing required");
      }
      const probe = await json("/v1/limits", saved.token);
      if (probe.status !== 200) throw new Error("desktop credential rejected or revoked; trusted re-pairing required");
      return { token: saved.token };
    }
    const root = readFileSync(join(configDir, "root-token"), "utf8").trim();
    const pair = await json("/v1/pair", root, { name: "desktop-shell", scopes: "express,notify,settings" });
    if (pair.status !== 200 || typeof pair.body?.token !== "string" || typeof pair.body?.clientId !== "string") {
      throw new Error("native desktop pairing failed");
    }
    writeFileSync(pending, JSON.stringify({ instanceId: health.body.instanceId, clientId: pair.body.clientId, token: pair.body.token }), { mode: 0o600 });
    renameSync(pending, path);
    return { token: pair.body.token };
  } finally {
    rmSync(pending, { force: true });
    lock.release();
  }
}
