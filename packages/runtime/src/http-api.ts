import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { localParts, type DailyQuotaPolicy, type QuotaKind, type WorkBriefing } from "@maneki-pet/core";

import {
  ADMIN_SCOPE,
  BRIEFING_SCOPE,
  EXPRESS_SCOPE,
  NAMED_CLIENT_NAME,
  NAMED_CLIENT_SCOPES,
  REMINDER_CANCEL_SCOPE,
  REMINDER_READ_SCOPE,
  REMINDER_SCOPE,
  REMINDER_SCOPES,
  SETTINGS_SCOPE,
  briefingIdentityProof,
  checkHost,
  checkOrigin,
  expressionIdentityProof,
  generateToken,
  hashToken,
  parseBearer,
  reminderCancelIdentityProof,
  reminderIdentityProof,
  reminderReadIdentityProof,
  runtimeIdentityProof,
  speechHostIdentityProof,
  TicketIssuer,
} from "./auth.js";
import type { EventFeed } from "./events.js";
import { expressionStates, type ExpressionStateFeed } from "./expression-state.js";
import type { LimitsView, NotificationBudget, RuntimeLimitsConfig } from "./quota.js";
import type { RuntimeStore } from "./store.js";
import { validateObject } from "./validate.js";
import type { AssistantService } from "./assistant-service.js";
import { handleAssistantHttp } from "./assistant-http.js";
import { ObservationReportError, type SessionObservations } from "./session-observations.js";
import { AssistantError } from "./assistant-settings.js";
import type { SpeechHostBroker, SpeechHostRegistration } from "./speech-host.js";

const MAX_BODY_BYTES = 64 * 1024;
const clientProofs = {
  expression: { scope: EXPRESS_SCOPE, sign: expressionIdentityProof },
  briefing: { scope: BRIEFING_SCOPE, sign: briefingIdentityProof },
  reminder: { scope: REMINDER_SCOPE, sign: reminderIdentityProof },
  "reminder-read": { scope: REMINDER_READ_SCOPE, sign: reminderReadIdentityProof },
  "reminder-cancel": { scope: REMINDER_CANCEL_SCOPE, sign: reminderCancelIdentityProof },
} as const;
const reminderRoutes = {
  [REMINDER_SCOPE]: { identity: "/v1/reminders/identity", method: "POST", operation: "/v1/reminders" },
  [REMINDER_READ_SCOPE]: { identity: "/v1/reminders/read/identity", method: "GET", operation: "/v1/reminders/pending" },
  [REMINDER_CANCEL_SCOPE]: { identity: "/v1/reminders/cancel/identity", method: "POST", operation: "/v1/reminders/cancel" },
} as const;
const revokeRoutes = new Map<string, Exclude<keyof typeof clientProofs, "expression">>([
  ["/v1/admin/briefing/revoke", "briefing"],
  ["/v1/admin/reminders/revoke", "reminder"],
  ["/v1/admin/reminders/read/revoke", "reminder-read"],
  ["/v1/admin/reminders/cancel/revoke", "reminder-cancel"],
]);

export interface LocalHttpApiDeps {
  assistant?: AssistantService;
  speechHost?: SpeechHostBroker;
  observations?: SessionObservations;
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
  expressions: ExpressionStateFeed;
  dnd: { get(): boolean; set(value: boolean): void };
  /** 受信管理入口请求退出（保存状态、关服务、释放锁）后回调。 */
  onShutdown?: () => void;
  onClientRevoked: (clientId: string) => void;
  /** M2b 派发：配置了 dsh 网关时提供任务服务；未配置时任务路由显式 501。 */
  tasks?: {
    submit(entry: { clientRequestId: string; prompt: string; workdir: string }): Promise<{ outcome: string; task?: unknown; reason?: string }>;
    describe(brokerRequestId: string, clientId: string): Promise<unknown>;
    cancel(brokerRequestId: string, clientId: string): Promise<unknown>;
  };
}

interface AuthedClient {
  clientId: string;
  name: string;
  scopes: string[];
}

export class LocalHttpApi {
  private server: Server | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
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
    if (this.stopPromise) return this.stopPromise;
    const server = this.server;
    if (!server) {
      return;
    }
    this.stopping = true;
    this.stopPromise = new Promise<void>((resolve) => {
      // 给已开始的响应有限排空时间，未传完的 body 不能无限阻止退出。
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        this.server = undefined;
        resolve();
      });
    });
    await this.stopPromise;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      this.sendJson(res, 503, { error: "runtime_stopping" });
      return;
    }
    const boundPort = (this.server?.address() as { port: number }).port;
    const expectedHost = `${this.deps.host}:${boundPort}`;
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
        "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    if (method === "GET" && url === "/v1/health") {
      // 发现元数据只含端口、协议版本、实例 ID，不含令牌（§6.1）。
      const challenge = req.headers["x-maneki-challenge"];
      const proof = typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge)
        ? { identityProof: runtimeIdentityProof(this.deps.rootToken, challenge, 1, this.deps.instanceId, boundPort) } : {};
      const speechClient = req.headers["x-maneki-speech-client"], speechChallenge = req.headers["x-maneki-speech-challenge"];
      const record = typeof speechClient === "string" && /^client-[0-9a-f]{12}$/.test(speechClient) ? this.deps.store.findClient(speechClient) : null;
      const speechProof = record && !record.revokedAt && record.scopes.includes("speech_host") && typeof speechChallenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(speechChallenge)
        ? { speechProof: speechHostIdentityProof(record.tokenHash, record.clientId, speechChallenge, this.deps.instanceId, boundPort) } : {};
      const expressionProof = this.clientProof(req, "expression", boundPort);
      const briefingProof = this.clientProof(req, "briefing", boundPort);
      const reminderProof = this.clientProof(req, "reminder", boundPort);
      const reminderReadProof = this.clientProof(req, "reminder-read", boundPort);
      const reminderCancelProof = this.clientProof(req, "reminder-cancel", boundPort);
      if (reminderReadProof || reminderCancelProof) res.setHeader("cache-control", "no-store");
      this.sendJson(res, 200, { protocolVersion: 1, instanceId: this.deps.instanceId, version: this.deps.version,
        ...proof, ...speechProof, expressionProof, briefingProof, reminderProof, reminderReadProof, reminderCancelProof });
      return;
    }

    const auth = this.authenticate(req);
    if (!auth.ok) {
      this.sendJson(res, auth.status, { error: auth.reason });
      return;
    }
    const client = auth.client;
    const reminderScope = REMINDER_SCOPES.find(scope => hasScope(client, scope));
    if (reminderScope) {
      await this.handleAgentReminders(req, res, client, reminderScope, method, url);
      return;
    }
    const requiredReminderScope = REMINDER_SCOPES.find(scope => {
      const route = reminderRoutes[scope];
      return route.identity === url || route.operation === url;
    });
    if (requiredReminderScope) {
      this.forbidden(res, `${requiredReminderScope} scope required`);
      return;
    }
    if (hasScope(client, BRIEFING_SCOPE)) {
      // 专属只读身份也不能访问其他普通已配对客户端可见的路由（例如勿扰状态）。
      if (method !== "GET" || (url !== "/v1/briefing" && url !== "/v1/briefing/identity")) {
        this.forbidden(res, "briefing client is read-only");
        return;
      }
      res.setHeader("cache-control", "no-store");
      if (url === "/v1/briefing/identity") {
        this.sendJson(res, 200, { clientId: client.clientId, name: client.name });
        return;
      }
      if (!this.deps.observations) {
        this.sendJson(res, 503, { error: "observations_unavailable" });
        return;
      }
      const personal = this.deps.store.assistantStore();
      const timeZone = personal.briefingTimeZone();
      const date = localParts(Date.now(), timeZone).date;
      const briefing: WorkBriefing = { date, timeZone, ...personal.dueTodos(date), ...this.deps.observations.briefing() };
      this.sendJson(res, 200, briefing);
      return;
    }
    if (url === "/v1/briefing" || url === "/v1/briefing/identity") {
      this.forbidden(res, "briefing_read scope required");
      return;
    }
    if (url.startsWith("/v1/speech-host/")) {
      if (!hasScope(client, "speech_host")) { this.forbidden(res, "speech host scope required"); return; }
      const broker = this.deps.speechHost;
      if (!broker) { this.sendJson(res, 503, { error: "speech_host_unavailable" }); return; }
      if (method === "GET" && url === "/v1/speech-host/identity") { this.sendJson(res, 200, { clientId: client.clientId }); return; }
      if (method !== "POST") { this.sendJson(res, 404, { error: "not_found" }); return; }
      const body = await this.readJson(req, res);
      if (!body) return;
      try {
        if (url === "/v1/speech-host/register") {
          if (Object.keys(body).some((key) => !["protocolVersion", "sourceId", "sourceSecret", "providerId", "locality", "languages", "ready"].includes(key))) throw new AssistantError(400, "speech_host_invalid");
          broker.register(client.clientId, body as unknown as SpeechHostRegistration);
          this.sendJson(res, 200, { accepted: true }); return;
        }
        const spec = { sourceId: { type: "string", required: true, maxLength: 80 }, sourceSecret: { type: "string", required: true, maxLength: 43 } } as const;
        if (url === "/v1/speech-host/claim") {
          const value = validateObject(body, spec);
          if (!value.ok) throw new AssistantError(400, "speech_host_invalid");
          this.sendJson(res, 200, { job: broker.claim(client.clientId, value.value.sourceId as string, value.value.sourceSecret as string) }); return;
        }
        const value = validateObject(body, { ...spec, jobId: { type: "string", required: true, maxLength: 80 }, text: { type: "string", required: false, maxLength: 4000 }, failed: { type: "boolean", required: false } });
        if (!value.ok) throw new AssistantError(400, "speech_host_invalid");
        const { sourceId, sourceSecret, jobId, text, failed } = value.value;
        if (url === "/v1/speech-host/pending") { this.sendJson(res, 200, { pending: broker.pending(client.clientId, sourceId as string, sourceSecret as string, jobId as string) }); return; }
        if (url === "/v1/speech-host/ack") { const accepted = broker.acknowledge(client.clientId, sourceId as string, sourceSecret as string, jobId as string); this.sendJson(res, accepted ? 200 : 409, { accepted }); return; }
        if (url === "/v1/speech-host/complete") {
          const accepted = failed === true && text === undefined ? broker.fail(client.clientId, sourceId as string, sourceSecret as string, jobId as string) : failed === undefined && typeof text === "string" ? broker.complete(client.clientId, sourceId as string, sourceSecret as string, jobId as string, text) : false;
          this.sendJson(res, accepted ? 200 : 409, { accepted }); return;
        }
        this.sendJson(res, 404, { error: "not_found" }); return;
      } catch (error) {
        if (!(error instanceof AssistantError)) throw error;
        this.sendJson(res, error.status, { error: error.code }); return;
      }
    }
    if (url.startsWith("/v1/assistant/")) {
      if (!this.deps.assistant) {
        this.sendJson(res, 503, { error: "assistant_unavailable" });
        return;
      }
      await handleAssistantHttp(req, res, client, this.deps.assistant, (maxBytes) =>
        this.readJson(req, res, maxBytes ?? (url === "/v1/assistant/voice/transcribe" ? 1400000 : MAX_BODY_BYTES)));
      return;
    }

    if (method === "POST" && url === "/v1/observations/sessions") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "observations require express scope");
        return;
      }
      if (!this.deps.observations) {
        this.sendJson(res, 503, { error: "observations_unavailable" });
        return;
      }
      const body = await this.readJson(req, res);
      if (body === undefined) return;
      try {
        this.deps.observations.report(client.clientId, body);
        this.sendJson(res, 202, { accepted: true });
      } catch (error) {
        if (!(error instanceof ObservationReportError)) throw error;
        this.sendJson(res, error.status, { error: error.message });
      }
      return;
    }

    if ((method === "GET" || method === "POST") && url === "/v1/expressions/state") {
      if (!hasScope(client, EXPRESS_SCOPE)) {
        this.forbidden(res, "expression state requires express scope");
        return;
      }
      if (method === "POST") {
        const body = await this.readJson(req, res);
        if (body === undefined) return;
        const checked = validateObject(body, {
          sourceId: { type: "string", required: true, maxLength: 36 },
          state: { type: "string", required: true, maxLength: 20, enumValues: expressionStates },
        });
        if (!checked.ok || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(checked.value.sourceId as string)) {
          this.sendJson(res, 400, { error: checked.ok ? "sourceId must be a UUID" : checked.reason });
          return;
        }
        if (!this.deps.expressions.update(client.clientId, checked.value.sourceId as string, checked.value.state as typeof expressionStates[number])) {
          this.sendJson(res, 429, { error: "expression source limit reached" });
          return;
        }
      }
      this.sendJson(res, method === "POST" ? 202 : 200, { state: this.deps.expressions.current() });
      return;
    }

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
      const namedScope = NAMED_CLIENT_SCOPES.find(scope => requested.includes(scope));
      if (namedScope) {
        const name = checked.value.name as string;
        if (requested.length !== 1 || !NAMED_CLIENT_NAME.test(name)) {
          this.sendJson(res, 400, { error: `${namedScope} requires a dedicated named client` });
          return;
        }
        // 唯一 Runtime 写者；从查名到签发无异步操作。已撤销名称也保留。
        if (this.deps.store.findNamedClient(name, namedScope)) {
          this.sendJson(res, 409, { error: namedScope === BRIEFING_SCOPE ? "briefing_name_already_registered" : "reminder_name_already_registered" });
          return;
        }
        if ((namedScope === REMINDER_READ_SCOPE || namedScope === REMINDER_CANCEL_SCOPE) &&
            !this.deps.store.findNamedClient(name, REMINDER_SCOPE)) {
          this.sendJson(res, 409, { error: "reminder_creator_not_registered" });
          return;
        }
      }
      const invalid = requested.find((scope) => !["express", "notify", "tasks", SETTINGS_SCOPE, "assistant", "speech_host", ...NAMED_CLIENT_SCOPES].includes(scope));
      if (invalid !== undefined) {
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
      if (namedScope === REMINDER_READ_SCOPE || namedScope === REMINDER_CANCEL_SCOPE) res.setHeader("cache-control", "no-store");
      this.sendJson(res, 200, { clientId, token });
      return;
    }

    const purpose = revokeRoutes.get(url);
    if (method === "POST" && purpose) {
      if (!hasScope(client, ADMIN_SCOPE)) { this.forbidden(res, "revocation requires admin scope"); return; }
      const body = await this.readJson(req, res);
      if (!body) return;
      if (Object.keys(body).length !== 1 || typeof body.name !== "string" || !NAMED_CLIENT_NAME.test(body.name)) {
        this.sendJson(res, 400, { error: `${purpose}_name_invalid` });
        return;
      }
      const target = this.deps.store.findNamedClient(body.name, clientProofs[purpose].scope);
      if (!target) { this.sendJson(res, 404, { error: `${purpose}_client_not_found` }); return; }
      if (!target.revokedAt) this.revokeClient(target.clientId, client.clientId);
      if (purpose === "reminder-read" || purpose === "reminder-cancel") res.setHeader("cache-control", "no-store");
      this.sendJson(res, 200, { revoked: target.clientId });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/clients/") && url.endsWith("/revoke")) {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "revocation requires admin scope");
        return;
      }
      const targetId = url.slice("/v1/clients/".length, -"/revoke".length);
      if (targetId === "root") {
        this.sendJson(res, 409, { error: "installation identity cannot be revoked as a client" });
        return;
      }
      const target = this.deps.store.findClient(targetId);
      if (!target) {
        this.sendJson(res, 404, { error: "client not found" });
        return;
      }
      this.revokeClient(targetId, client.clientId);
      this.sendJson(res, 200, { revoked: targetId });
      return;
    }

    if (method === "GET" && url === "/v1/clients") {
      if (!hasScope(client, ADMIN_SCOPE)) {
        this.forbidden(res, "listing clients requires admin scope");
        return;
      }
      const clients = this.deps.store.listClients().map(({ clientId, name, scopes, createdAt, revokedAt }) => ({
        clientId, name, scopes, createdAt, revokedAt,
      }));
      this.sendJson(res, 200, { clients });
      return;
    }

    if (method === "POST" && url === "/v1/ws-ticket") {
      if (!hasScope(client, EXPRESS_SCOPE) && !hasScope(client, "assistant")) {
        this.forbidden(res, "ws tickets require express or assistant scope");
        return;
      }
      const issued = this.deps.tickets.issue({ clientId: client.clientId, origin: req.headers.origin, scopes: client.scopes });
      this.sendJson(res, 200, { ticket: issued.ticket, expiresAtMs: issued.expiresAtMs, path: "/v1/events" });
      return;
    }

    if (method === "GET" && url === "/v1/dnd") {
      this.sendJson(res, 200, { enabled: this.deps.dnd.get() });
      return;
    }

    if (method === "POST" && url === "/v1/dnd") {
      if (!hasScope(client, SETTINGS_SCOPE)) {
        this.forbidden(res, "dnd toggle requires settings scope");
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
      if (!hasScope(client, "tasks")) {
        this.forbidden(res, "task dispatch requires tasks scope");
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
      if (!hasScope(client, "tasks")) {
        this.forbidden(res, "task query requires tasks scope");
        return;
      }
      const id = url.slice("/v1/tasks/".length);
      try {
        this.sendJson(res, 200, await this.deps.tasks.describe(id, client.clientId));
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
      if (!hasScope(client, "tasks")) {
        this.forbidden(res, "task cancel requires tasks scope");
        return;
      }
      const id = url.slice("/v1/tasks/".length, -"/cancel".length);
      try {
        this.sendJson(res, 200, await this.deps.tasks.cancel(id, client.clientId));
      } catch (error) {
        const status = (error as { code?: unknown })?.code === "unavailable" ? 503 : 404;
        this.sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && url === "/v1/admin/speech-recover") {
      if (!hasScope(client, ADMIN_SCOPE)) { this.forbidden(res, "speech recovery requires admin scope"); return; }
      const recovered = this.deps.speechHost?.recover() ?? false;
      if (recovered) this.deps.store.audit("speech_host.recovered", client.clientId, {}, new Date().toISOString());
      this.sendJson(res, recovered ? 200 : 409, { recovered }); return;
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

  private async handleAgentReminders(
    req: IncomingMessage, res: ServerResponse, client: AuthedClient,
    scope: typeof REMINDER_SCOPES[number], method: string, url: string,
  ): Promise<void> {
    res.setHeader("cache-control", "no-store");
    if (client.scopes.length !== 1) { this.forbidden(res, `${scope} requires a dedicated client`); return; }
    const route = reminderRoutes[scope];
    if (method === "GET" && url === route.identity) {
      this.sendJson(res, 200, { clientId: client.clientId, name: client.name });
      return;
    }
    if (method !== route.method || url !== route.operation) {
      this.forbidden(res, scope === REMINDER_SCOPE ? "reminder client can only create reminders" : `${scope} client is restricted to its reminder routes`);
      return;
    }
    const assistant = this.deps.assistant;
    if (!assistant) { this.sendJson(res, 503, { error: "assistant_unavailable" }); return; }
    try {
      if (scope === REMINDER_SCOPE) {
        const body = await this.readJson(req, res);
        if (body) this.sendJson(res, 200, assistant.createAgentReminder(client.clientId, body));
        return;
      }
      // 名称登记保留到撤销之后；管理身份只对应此创建身份的历史回执。
      const owner = this.deps.store.findNamedClient(client.name, REMINDER_SCOPE);
      if (!owner) { this.forbidden(res, "reminder creator is not registered"); return; }
      if (scope === REMINDER_READ_SCOPE) {
        this.sendJson(res, 200, assistant.listAgentReminders(owner.clientId));
        return;
      }
      const body = await this.readJson(req, res);
      if (body) this.sendJson(res, 200, assistant.cancelAgentReminder(client.clientId, owner.clientId, body));
    } catch (error) {
      if (!(error instanceof AssistantError)) throw error;
      this.sendJson(res, error.status, { error: error.code });
    }
  }

  private revokeClient(targetId: string, actorId: string): void {
    const at = new Date().toISOString();
    this.deps.store.revokeClient(targetId, at);
    this.deps.tickets.revokeClient(targetId);
    this.deps.onClientRevoked(targetId);
    this.deps.store.audit("client.revoked", targetId, { by: actorId }, at);
  }

  private clientProof(req: IncomingMessage, purpose: keyof typeof clientProofs, boundPort: number): string | undefined {
    const clientId = req.headers[`x-maneki-${purpose}-client`];
    const challenge = req.headers[`x-maneki-${purpose}-challenge`];
    if (typeof clientId !== "string" || !/^client-[0-9a-f]{12}$/.test(clientId) ||
        typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return undefined;
    const client = this.deps.store.findClient(clientId);
    const { scope, sign } = clientProofs[purpose];
    if (!client || client.revokedAt || !client.scopes.includes(scope) || (purpose.startsWith("reminder") && client.scopes.length !== 1)) return undefined;
    return sign(client.tokenHash, clientId, challenge, this.deps.instanceId, boundPort);
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
    return { ok: true, client: { clientId: record.clientId, name: record.name, scopes: record.scopes } };
  }

  private auditDenied(reason: string): void {
    this.deps.store.audit("auth.denied", "http", { reason }, new Date().toISOString());
  }

  private async readJson(req: IncomingMessage, res: ServerResponse, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        this.sendJson(res, 413, { error: "request body too large" });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    if (this.stopping) {
      this.sendJson(res, 503, { error: "runtime_stopping" });
      return undefined;
    }
    // 读取请求体会让出事件循环；期间撤销的凭证不能继续完成写操作。
    const auth = this.authenticate(req);
    if (!auth.ok) {
      this.sendJson(res, auth.status, { error: auth.reason });
      return undefined;
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
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
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
