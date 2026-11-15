import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { generateToken, runtimeIdentityProof } from "./auth.js";
import { RELEASE_VERSION } from "./release-version.js";

export class DesktopCredentialError extends Error {
  constructor(readonly code: "invalid_config" | "timeout" | "runtime_unavailable" | "protocol_mismatch" | "identity_mismatch" | "credential_rejected" | "pairing_failed" | "pairing_busy" | "pairing_required" | "speech_recovery_blocked") { super(code); }
}

/** 仅供受信管理进程：完成身份核验后才允许发送凭证。 */
export async function openAdminSession(configDir: string, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopCredentialError("invalid_config");
  let root: string;
  try { root = readFileSync(join(configDir, "root-token"), "utf8").trim(); }
  catch { throw new DesktopCredentialError("invalid_config"); }
  if (!root) throw new DesktopCredentialError("invalid_config");
  const exchange = async (expectedInstanceId?: string, operation?: { path: string; body: unknown; token: string }) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    const signal = AbortSignal.timeout(3000);
    const json = (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}, expectedSocket?: Socket) =>
      new Promise<{ status: number; body: Record<string, unknown>; socket: Socket }>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", agent, signal,
          headers: { "content-type": "application/json", ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }) },
        }, (res) => {
          const socket = res.socket;
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 16_384) {
              reject(new DesktopCredentialError("protocol_mismatch"));
              req.destroy();
            } else chunks.push(chunk);
          });
          res.on("end", () => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
              reject(new DesktopCredentialError("runtime_unavailable"));
              return;
            }
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (typeof value !== "object" || value === null || Array.isArray(value) || !socket) throw new Error();
              resolve({ status: res.statusCode ?? 0, body: value as Record<string, unknown>, socket });
            } catch { reject(new DesktopCredentialError("protocol_mismatch")); }
          });
        });
        req.on("error", reject);
        req.on("socket", (socket) => {
          // req.end 之前检查，禁止 Node 在连接关闭后重连并发出已排队的凭证。
          if (expectedSocket && (socket !== expectedSocket || socket.destroyed)) {
            req.destroy(new DesktopCredentialError("identity_mismatch"));
            return;
          }
          req.end(payload);
        });
      });
    try {
      const challenge = generateToken();
      const health = await json("/v1/health", undefined, undefined, { "x-maneki-challenge": challenge });
      if (health.status !== 200 || health.body.protocolVersion !== 1 || typeof health.body.instanceId !== "string") throw new DesktopCredentialError("protocol_mismatch");
      const proof = health.body.identityProof;
      const expected = runtimeIdentityProof(root, challenge, 1, health.body.instanceId, port);
      if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex")) ||
          (expectedInstanceId !== undefined && health.body.instanceId !== expectedInstanceId)) throw new DesktopCredentialError("identity_mismatch");
      if (health.body.version !== RELEASE_VERSION) throw new DesktopCredentialError("protocol_mismatch");
      const reply = operation ? await json(operation.path, operation.body, operation.token, {}, health.socket) : health;
      return { instanceId: health.body.instanceId, response: { status: reply.status, body: reply.body } };
    } catch (error) {
      if (error instanceof DesktopCredentialError) throw error;
      throw new DesktopCredentialError(signal.aborted ? "timeout" : "runtime_unavailable");
    } finally { agent.destroy(); }
  };
  const { instanceId } = await exchange();
  return { instanceId, request: async (path: string, body?: unknown, token = root) => (await exchange(instanceId, { path, body, token })).response };
}
