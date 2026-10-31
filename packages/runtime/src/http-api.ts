import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { DailyQuotaPolicy, QuotaKind } from "@maneki-pet/core";

import {
  ADMIN_SCOPE,
  EXPRESS_SCOPE,
  checkHost,
  checkOrigin,
  generateToken,
  hashToken,
  parseBearer,
  TicketIssuer,
} from "./auth.js";
import type { EventFeed } from "./events.js";
import type { LimitsView, NotificationBudget, RuntimeLimitsConfig } from "./quota.js";
import type { RuntimeStore } from "./store.js";
import { validateObject } from "./validate.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface LocalHttpApiDeps {
  host: string;
  port: number;
  store: RuntimeStore;
  tickets: TicketIssuer;
  originAllowlist: string[];
  instanceId: string;
  version: string;
  rootToken: string;
  config: RuntimeLimitsConfig;
  quotaPolicy: DailyQuotaPolicy;
  notifications: NotificationBudget;
  feed: EventFeed;
  dnd: { get(): boolean; set(value: boolean): void };
  /** 受信管理入口请求退出（保存状态、关服务、释放锁）后回调。 */
  onShutdown?: () => void;
  /** M2b 派发：配置了 dsh 网关时提供任务服务；未配置时任务路由显式 501。 */
  tasks?: {
    submit(entry: { clientRequestId: string; prompt: string; workdir: string }): Promise<{ outcome: string; task?: unknown; reason?: string }>;
    describe(brokerRequestId: string): Promise<unknown>;
    cancel(brokerRequestId: string): Promise<unknown>;
  };
}

interface AuthedClient {
  clientId: string;
  scopes: string[];
}

export class LocalHttpApi {
  private server: Server | undefined;
  private readonly deps: LocalHttpApiDeps;

  constructor(deps: LocalHttpApiDeps) {
    this.deps = deps;
  }

  async start(): Promise<{ port: number }> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => this.sendJson(res, 500, { error: "internal error" }));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.deps.port, this.deps.host, () => resolve());
    });
    return { port: (server.address() as { port: number }).port };
  }

  /** 供 WsHub 挂接 upgrade 事件。 */
  get rawServer(): Server {
    if (!this.server) {
      throw new Error("http api not started");
    }
    return this.server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const expectedHost = `${this.deps.host}:${(this.server?.address() as { port: number }).port}`;
    const hostCheck = checkHost(req.headers.host, expectedHost);
    if (!hostCheck.ok) {
      this.sendJson(res, hostCheck.status, { error: hostCheck.reason });
      return;
    }
    const originCheck = checkOrigin(req.headers.origin, this.deps.originAllowlist);
    if (!originCheck.ok) {
      this.sendJson(res, originCheck.status, { error: originCheck.reason });
      return;
    }
    // 白名单内的浏览器来源回显 CORS 头；CORS 不是鉴权替代（§7.1），鉴权仍逐请求进行。
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-credentials", "true");
    }
    const url = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    if (method === "GET" && url === "/v1/health") {
      // 发现元数据只含端口、协议版本、实例 ID，不含令牌（§6.1）。
      this.sendJson(res, 200, { protocolVersion: 1, instanceId: this.deps.instanceId, version: this.deps.version });
      return;
    }

    const auth = this.authenticate(req);
    if (!auth.ok) {
      this.sendJson(res, auth.status, { error: auth.reason });
      return;
    }
    const client = auth.client;

    if (method === "POST" && url === "/v1/pair") {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "pairing requires admin scope");
        return;
      }
      const body = await this.readJson(req, res);
      if (body === undefined) {
        return;
      }
      const checked = validateObject(body, {
        name: { type: "string", required: true, maxLength: 100 },
        scopes: { type: "string", required: true, maxLength: 200 },
      });
      if (!checked.ok) {
        this.sendJson(res, 400, { error: checked.reason });
        return;
      }
      const requested = (checked.value.scopes as string).split(",").map((scope) => scope.trim());
      const invalid = requested.find((scope) => !["express", "notify", "tasks"].includes(scope));
      if (invalid) {
        this.sendJson(res, 400, { error: `unknown scope "${invalid}"` });
        return;
      }
      const token = generateToken();
      const clientId = `client-${randomBytes(6).toString("hex")}`;
      this.deps.store.createClient({
        clientId,
        name: checked.value.name as string,
        tokenHash: hashToken(token),
        scopes: requested,
        createdAt: new Date().toISOString(),
      });
      this.deps.store.audit("client.paired", clientId, { name: checked.value.name, scopes: requested }, new Date().toISOString());
      this.sendJson(res, 200, { clientId, token });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/clients/") && url.endsWith("/revoke")) {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "revocation requires admin scope");
        return;
      }
      const targetId = url.slice("/v1/clients/".length, -"/revoke".length);
      const target = this.deps.store.findClient(targetId);
      if (!target) {
        this.sendJson(res, 404, { error: "client not found" });
        return;
      }
      this.deps.store.revokeClient(targetId, new Date().toISOString());
      this.deps.store.audit("client.revoked", targetId, { by: client.clientId }, new Date().toISOString());
      this.sendJson(res, 200, { revoked: targetId });
      return;
    }

    if (method === "GET" && url === "/v1/clients") {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "listing clients requires admin scope");
        return;
      }
      this.sendJson(res, 200, { clients: this.deps.store.listClients() });
      return;
    }

    if (method === "POST" && url === "/v1/ws-ticket") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "ws tickets require express scope");
        return;
      }
      const issued = this.deps.tickets.issue();
      this.sendJson(res, 200, { ticket: issued.ticket, expiresAtMs: issued.expiresAtMs, path: "/v1/events" });
      return;
    }

    if (method === "GET" && url === "/v1/dnd") {
      this.sendJson(res, 200, { enabled: this.deps.dnd.get() });
      return;
    }

    if (method === "POST" && url === "/v1/dnd") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "dnd toggle requires express scope");
        return;
      }
      const body = await this.readJson(req, res);
      if (body === undefined) {
        return;
      }
      const checked = validateObject(body, { enabled: { type: "boolean", required: true } });
      if (!checked.ok) {
        this.sendJson(res, 400, { error: checked.reason });
        return;
      }
      this.deps.dnd.set(checked.value.enabled as boolean);
      this.deps.feed.publish("dnd.changed", { enabled: checked.value.enabled });
      this.sendJson(res, 200, { enabled: this.deps.dnd.get() });
      return;
    }

    if (method === "POST" && url === "/v1/usage/record") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "usage recording requires express scope");
        return;
      }
      const body = await this.readJson(req, res);
      if (body === undefined) {
        return;
      }
      const checked = validateObject(body, {
        kind: { type: "string", required: true, maxLength: 20, enumValues: ["interactive", "proactive"] satisfies QuotaKind[] },
        tokens: { type: "number", required: true, min: 1, max: 10_000_000 },
      });
      if (!checked.ok) {
        this.sendJson(res, 400, { error: checked.reason });
        return;
      }
      this.deps.quotaPolicy.record(checked.value.tokens as number);
      this.sendJson(res, 200, { recorded: true });
      return;
    }

    if (method === "GET" && url === "/v1/limits") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "limits view requires express scope");
        return;
      }
      this.sendJson(res, 200, limitsSnapshot(this.deps));
      return;
    }

    if (method === "POST" && url === "/v1/tasks") {
      if (!this.deps.tasks) {
        this.sendJson(res, 501, { error: "task dispatch not configured (config.dsh missing)" });
        return;
      }
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "task dispatch requires express scope");
        return;
      }
      const body = await this.readJson(req, res);
      if (body === undefined) return;
      const checked = validateObject(body, {
        clientRequestId: { type: "string", required: true, maxLength: 120 },
        prompt: { type: "string", required: true, maxLength: 32_000 },
        workdir: { type: "string", required: true, maxLength: 400 },
      });
      if (!checked.ok) {
        this.sendJson(res, 400, { error: checked.reason });
        return;
      }
      const entry = checked.value as { clientRequestId: string; prompt: string; workdir: string };
      const outcome = await this.deps.tasks.submit(entry);
      if (outcome.outcome === "rejected") {
        this.sendJson(res, 409, { outcome, error: outcome.reason });
        return;
      }
      this.deps.store.audit("task.submitted", (outcome.task as { brokerRequestId?: string })?.brokerRequestId ?? "", { clientRequestId: entry.clientRequestId }, new Date().toISOString());
      this.sendJson(res, 202, outcome);
      return;
    }

    if (method === "GET" && url.startsWith("/v1/tasks/")) {
      if (!this.deps.tasks) {
        this.sendJson(res, 501, { error: "task dispatch not configured (config.dsh missing)" });
        return;
      }
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "task query requires express scope");
        return;
      }
      const id = url.slice("/v1/tasks/".length);
      try {
        this.sendJson(res, 200, await this.deps.tasks.describe(id));
      } catch (error) {
        this.sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && url.startsWith("/v1/tasks/") && url.endsWith("/cancel")) {
      if (!this.deps.tasks) {
        this.sendJson(res, 501, { error: "task dispatch not configured (config.dsh missing)" });
        return;
      }
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "task cancel requires express scope");
        return;
      }
      const id = url.slice("/v1/tasks/".length, -"/cancel".length);
      try {
        this.sendJson(res, 200, await this.deps.tasks.cancel(id));
      } catch (error) {
        this.sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && url === "/v1/shutdown") {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "shutdown requires admin scope");
        return;
      }
      this.deps.store.audit("runtime.shutdown_requested", client.clientId, {}, new Date().toISOString());
      this.sendJson(res, 200, { stopping: true });
      if (this.deps.onShutdown) {
        setTimeout(() => this.deps.onShutdown?.(), 50);
      }
      return;
    }

    this.sendJson(res, 404, { error: "not found" });
  }

  private authenticate(req: IncomingMessage): { ok: true; client: AuthedClient } | { ok: false; status: 400 | 401 | 403; reason: string } {
    const bearer = parseBearer(req.headers.authorization);
    if (!bearer.ok) {
      this.auditDenied(bearer.reason);
      return bearer;
    }
    const record = this.deps.store.findClientByTokenHash(hashToken(bearer.token));
    if (!record) {
      this.auditDenied("unknown token");
      return { ok: false, status: 401, reason: "invalid token" };
    }
    if (record.revokedAt !== null) {
      this.auditDenied(`revoked client ${record.clientId}`);
      return { ok: false, status: 401, reason: "token has been revoked" };
    }
    return { ok: true, client: { clientId: record.clientId, scopes: record.scopes } };
  }

  private auditDenied(reason: string): void {
    this.deps.store.audit("auth.denied", "http", { reason }, new Date().toISOString());
  }

  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        this.sendJson(res, 413, { error: "request body too large" });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) {
      this.sendJson(res, 400, { error: "request body required" });
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.sendJson(res, 400, { error: "request body must be a JSON object" });
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "request body is not valid JSON" });
      return undefined;
    }
  }

  private forbidden(res: ServerResponse, reason: string): void {
    this.auditDenied(reason);
    this.sendJson(res, 403, { error: reason });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

function hasScope(client: AuthedClient, needed: string): boolean {
  return client.scopes.includes(needed);
}

export function limitsSnapshot(deps: LocalHttpApiDeps): LimitsView {
  const view: LimitsView = {
    dayKey: deps.quotaPolicy.dayKey(),
    proactive: {
      limit: deps.config.limits.proactiveDailyTokenLimit,
      used: deps.store.quotaTotal(deps.quotaPolicy.dayKey()),
      remaining: Math.max(0, deps.config.limits.proactiveDailyTokenLimit - deps.store.quotaTotal(deps.quotaPolicy.dayKey())),
    },
    interactive: null,
    meteringHealthy: deps.quotaPolicy.meteringUnhealthyReason === null,
    notifications: {
      maxPerHour: deps.config.limits.maxNotificationsPerHour,
      usedThisHour: deps.notifications.usedThisHour(Date.now()),
    },
  };
  if (deps.config.limits.interactiveDailyTokenLimit !== null) {
    view.interactive = {
      limit: deps.config.limits.interactiveDailyTokenLimit,
      used: deps.store.quotaTotal(deps.quotaPolicy.dayKey()),
      remaining: Math.max(0, deps.config.limits.interactiveDailyTokenLimit - deps.store.quotaTotal(deps.quotaPolicy.dayKey())),
    };
  }
  return view;
}
