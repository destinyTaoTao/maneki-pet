import { createHash, createHmac, randomBytes } from "node:crypto";

export const ADMIN_SCOPE = "admin";
export const EXPRESS_SCOPE = "express";
export const NOTIFY_SCOPE = "notify";
export const SETTINGS_SCOPE = "settings";
export const ALL_SCOPES = [ADMIN_SCOPE, EXPRESS_SCOPE, NOTIFY_SCOPE, "tasks", SETTINGS_SCOPE] as const;

/** 安装期随机令牌：32 字节 base64url；存储只保留 SHA-256。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function runtimeIdentityProof(rootToken: string, challenge: string, protocolVersion: number, instanceId: string, boundPort: number): string {
  return createHmac("sha256", rootToken).update(JSON.stringify(["maneki-runtime-identity-v1", challenge, protocolVersion, instanceId, boundPort])).digest("hex");
}

export type AuthCheck = { ok: true } | { ok: false; status: 400 | 401 | 403; reason: string };

/** 解析 Authorization: Bearer <token>；缺失/格式错是 401（不是 403）。 */
export function parseBearer(headerValue: string | undefined): { ok: true; token: string } | { ok: false; status: 401; reason: string } {
  if (!headerValue) {
    return { ok: false, status: 401, reason: "missing Authorization header" };
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(headerValue);
  if (!match) {
    return { ok: false, status: 401, reason: "malformed Authorization header" };
  }
  return { ok: true, token: match[1] as string };
}

/** Host 校验防 DNS rebinding：必须严格等于绑定地址。 */
export function checkHost(hostHeader: string | undefined, expectedHost: string): AuthCheck {
  if (!hostHeader) {
    return { ok: false, status: 403, reason: "missing Host header" };
  }
  if (hostHeader !== expectedHost) {
    return { ok: false, status: 403, reason: `host "${hostHeader}" is not the bound ${expectedHost}` };
  }
  return { ok: true };
}

/** Origin 白名单：无 Origin 的本机工具仍须 token 与 Host 校验；浏览器 Origin 必须在白名单内。 */
export function checkOrigin(originHeader: string | undefined, allowlist: string[]): AuthCheck {
  if (!originHeader) {
    return { ok: true };
  }
  if (!allowlist.includes(originHeader)) {
    return { ok: false, status: 403, reason: `origin "${originHeader}" is not in the configured allowlist` };
  }
  return { ok: true };
}

export function hasScope(scopes: string[], needed: string): boolean {
  return scopes.includes(needed);
}

const TICKET_TTL_MS = 30_000;

export interface TicketIdentity {
  clientId: string;
  origin: string | undefined;
  scopes: string[];
}

/** 一次性短期 WS 票据：用后即焚，过期失效，防重放。 */
export class TicketIssuer {
  private readonly outstanding = new Map<string, TicketIdentity & { expiresAtMs: number }>();

  issue(identity: TicketIdentity, nowMs: number = Date.now()): { ticket: string; expiresAtMs: number } {
    this.prune(nowMs);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAtMs = nowMs + TICKET_TTL_MS;
    this.outstanding.set(ticket, { ...identity, scopes: [...identity.scopes], expiresAtMs });
    return { ticket, expiresAtMs };
  }

  redeem(ticket: string, origin: string | undefined, nowMs: number = Date.now()): TicketIdentity | undefined {
    const identity = this.outstanding.get(ticket);
    if (!identity) {
      return undefined;
    }
    this.outstanding.delete(ticket);
    return nowMs < identity.expiresAtMs && identity.origin === origin ? identity : undefined;
  }

  revokeClient(clientId: string): void {
    for (const [ticket, identity] of this.outstanding) {
      if (identity.clientId === clientId) this.outstanding.delete(ticket);
    }
  }

  private prune(nowMs: number): void {
    for (const [ticket, identity] of this.outstanding) {
      if (nowMs >= identity.expiresAtMs) {
        this.outstanding.delete(ticket);
      }
    }
  }

  outstandingCount(): number {
    return this.outstanding.size;
  }
}
