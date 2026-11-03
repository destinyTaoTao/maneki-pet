import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { generateToken, runtimeIdentityProof } from "./auth.js";
import { InstanceLock } from "./lifecycle.js";

export class DesktopCredentialError extends Error {
  constructor(readonly code: "invalid_config" | "timeout" | "runtime_unavailable" | "protocol_mismatch" | "identity_mismatch" | "credential_rejected" | "pairing_failed" | "pairing_busy") {
    super(code);
  }
}

/** 仅供 native 管理入口；固定回环地址，不启动 Runtime 或打开数据库。 */
export async function desktopCredential(configDir: string, port: number): Promise<{ token: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopCredentialError("invalid_config");
  let root: string;
  try { root = readFileSync(join(configDir, "root-token"), "utf8").trim(); }
  catch { throw new DesktopCredentialError("invalid_config"); }
  if (!root) throw new DesktopCredentialError("invalid_config");
  const base = `http://127.0.0.1:${port}`;
  const json = async (path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    let response: Response;
    try { response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    }); } catch (error) { throw new DesktopCredentialError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "runtime_unavailable"); }
    let value: unknown;
    try { value = await response.json(); }
    catch (error) { throw new DesktopCredentialError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "protocol_mismatch"); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DesktopCredentialError("protocol_mismatch");
    return { status: response.status, body: value as Record<string, unknown> };
  };
  const challenge = generateToken();
  const health = await json("/v1/health", undefined, undefined, { "x-maneki-challenge": challenge });
  if (health.status !== 200 || health.body?.protocolVersion !== 1 || typeof health.body?.instanceId !== "string") {
    throw new DesktopCredentialError("protocol_mismatch");
  }
  const proof = health.body.identityProof;
  const expected = runtimeIdentityProof(root, challenge, 1, health.body.instanceId, port);
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"))) throw new DesktopCredentialError("identity_mismatch");
  // 管理入口并发配对也串行；残锁由现有 PID 存活检查回收。
  const lock = new InstanceLock(join(configDir, "desktop-client.lock"));
  try { lock.acquire(); } catch { throw new DesktopCredentialError("pairing_busy"); }
  const path = join(configDir, "desktop-client.json");
  const pending = `${path}.pending`;
  try {
    if (existsSync(path)) {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new DesktopCredentialError("invalid_config"); }
      if (typeof saved !== "object" || saved === null || !("instanceId" in saved) || saved.instanceId !== health.body.instanceId || !("token" in saved) || typeof saved.token !== "string") {
        throw new DesktopCredentialError("invalid_config");
      }
      const probe = await json("/v1/limits", saved.token);
      if (probe.status !== 200) throw new DesktopCredentialError("credential_rejected");
      return { token: saved.token };
    }
    const pair = await json("/v1/pair", root, { name: "desktop-shell", scopes: "express,notify,settings" });
    if (pair.status !== 200 || typeof pair.body?.token !== "string" || typeof pair.body?.clientId !== "string") {
      throw new DesktopCredentialError("pairing_failed");
    }
    writeFileSync(pending, JSON.stringify({ instanceId: health.body.instanceId, clientId: pair.body.clientId, token: pair.body.token }), { mode: 0o600 });
    renameSync(pending, path);
    return { token: pair.body.token };
  } finally {
    rmSync(pending, { force: true });
    lock.release();
  }
}
