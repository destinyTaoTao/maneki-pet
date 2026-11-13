import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";

/** 每次先在同一 TCP 连接验证 Runtime，再允许发送语音宿主凭证和正文。 */
export async function speechHostRequest(base: URL, token: string, clientId: string, path: string, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !/^[a-z-]+$/.test(path) || !/^client-[0-9a-f]{12}$/.test(clientId)) throw new Error("speech transport invalid");
  const port = Number(base.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("speech transport invalid");
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const call = (method: string, route: string, headers: Record<string, string>, payload: string | undefined, expected?: Socket, limit = 16384): Promise<{ value: Record<string, unknown>; socket: Socket }> => new Promise((resolve, reject) => {
    let responseSocket: Socket | undefined;
    const req = httpRequest({ hostname: "127.0.0.1", port, method, path: route, headers, agent, signal }, (res) => {
      responseSocket = res.socket;
      const chunks: Buffer[] = []; let length = 0;
      res.on("data", (chunk: Buffer) => { length += chunk.length; if (length > limit) req.destroy(new Error("speech response too large")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200 || !responseSocket) return reject(new Error("speech host unavailable"));
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
          resolve({ value: value as Record<string, unknown>, socket: responseSocket });
        } catch { reject(new Error("invalid speech response")); }
      });
    });
    req.on("error", reject);
    req.on("socket", (socket) => {
      if (expected && (socket !== expected || socket.destroyed)) { req.destroy(new Error("speech connection changed")); return; }
      req.end(payload);
    });
  });
  try {
    const challenge = randomBytes(32).toString("base64url");
    const proof = await call("GET", "/v1/health", { "x-maneki-speech-client": clientId, "x-maneki-speech-challenge": challenge }, undefined);
    const instanceId = proof.value.instanceId, given = proof.value.speechProof;
    if (proof.value.protocolVersion !== 1 || typeof instanceId !== "string" || typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) throw new Error("speech runtime identity mismatch");
    const key = createHash("sha256").update(token, "utf8").digest();
    const expected = createHmac("sha256", key).update(JSON.stringify(["maneki-speech-host-proof-v1", clientId, challenge, instanceId, port])).digest();
    key.fill(0);
    if (!timingSafeEqual(expected, Buffer.from(given, "hex"))) throw new Error("speech runtime identity mismatch");
    const payload = JSON.stringify(body);
    const reply = await call("POST", `/v1/speech-host/${path}`, { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }, payload, proof.socket, 1400000);
    return reply.value;
  } finally { agent.destroy(); }
}
