import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { generateToken, runtimeIdentityProof } from "./auth.js";

export class DesktopCredentialError extends Error {
  constructor(readonly code: "invalid_config" | "timeout" | "runtime_unavailable" | "protocol_mismatch" | "identity_mismatch" | "credential_rejected" | "pairing_failed" | "pairing_busy" | "pairing_required") { super(code); }
}

/** 仅供受信管理进程：完成身份核验后才允许发送凭证。 */
export async function openAdminSession(configDir: string, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopCredentialError("invalid_config");
  let root: string;
  try { root = readFileSync(join(configDir, "root-token"), "utf8").trim(); }
  catch { throw new DesktopCredentialError("invalid_config"); }
  if (!root) throw new DesktopCredentialError("invalid_config");
  const json = async (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { "content-type": "application/json", ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new DesktopCredentialError("protocol_mismatch");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 16_384) throw new DesktopCredentialError("protocol_mismatch");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new DesktopCredentialError("protocol_mismatch"); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DesktopCredentialError("protocol_mismatch");
      return { status: response.status, body: value as Record<string, unknown> };
    } catch (error) {
      if (error instanceof DesktopCredentialError) throw error;
      throw new DesktopCredentialError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "runtime_unavailable");
    }
  };
  const challenge = generateToken();
  const health = await json("/v1/health", undefined, undefined, { "x-maneki-challenge": challenge });
  if (health.status !== 200 || health.body.protocolVersion !== 1 || typeof health.body.instanceId !== "string") throw new DesktopCredentialError("protocol_mismatch");
  const proof = health.body.identityProof;
  const expected = runtimeIdentityProof(root, challenge, 1, health.body.instanceId, port);
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"))) throw new DesktopCredentialError("identity_mismatch");
  return { instanceId: health.body.instanceId, request: (path: string, body?: unknown, token = root) => json(path, body, token) };
}
