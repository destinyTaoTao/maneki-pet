import { CompanionService } from "./companion-service.js";
import { CompanionStore } from "./companion-store.js";
import { CompanionLeases } from "./companion-leases.js";
import { readAssistantSettings } from "./assistant-settings.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { DailyQuotaPolicy, MemoryContextService, TaskBroker, type PetState, type SystemNotifier } from "@maneki-pet/core";
import { AssistantService, type AssistantServiceOptions } from "./assistant-service.js";
import { WindowsSystemNotifier } from "./system-notifier.js";

import { generateToken, hashToken, TicketIssuer } from "./auth.js";
import { EventFeed } from "./events.js";
import { ExpressionStateFeed } from "./expression-state.js";
import { SessionObservations } from "./session-observations.js";
import { LocalHttpApi } from "./http-api.js";
import { InstanceLock, RuntimeLifecycle, type RuntimeState } from "./lifecycle.js";
import { McpExpressionBridge, type ExpressionSinks } from "./mcp-bridge.js";
import { McpMemoryClient } from "./mcp-memory-client.js";
import { loadRuntimeConfig, NotificationBudget } from "./quota.js";
import { RuntimeStore } from "./store.js";
import { TaskService } from "./task-service.js";
import { RELEASE_VERSION } from "./release-version.js";
import { WsHub } from "./ws.js";
import { SpeechHostBroker } from "./speech-host.js";

export interface RuntimeOptions {
  assistantMemory?: AssistantServiceOptions["memory"];
  speech?: AssistantServiceOptions["speech"];
  notifier?: SystemNotifier;
  chatProvider?: AssistantServiceOptions["provider"];
  configDir: string;
  /** 0（默认）= 由操作系统分配临时端口；正式部署用固定配置端口。 */
  port?: number;
  originAllowlist?: string[];
  version?: string;
  log?: (line: string) => void;
  /** 退出清理失败时通知宿主，可用于设置后台进程的退出码。 */
  onShutdownError?: () => void;
  /** WS 鉴权超时（测试可调短）。 */
  wsAuthTimeoutMs?: number;
}

export interface StartedRuntime {
  assistant: AssistantService;
  port: number;
  instanceId: string;
  rootToken: string;
  rootTokenPath: string;
  feed: EventFeed;
  store: RuntimeStore;
  /** 配置了 externalMemory 时可用（票据 #46）；未配置为 undefined。 */
  memory?: MemoryContextService;
  /** 配置了 dsh 网关时可用（M2b）；未配置为 undefined。 */
  tasks?: TaskService;
  state(): RuntimeState;
  startMcpStdioBridge(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 共享 Runtime 装配（architecture §2.1）：一个配置目录一个实例、
 * SQLite 单一拥有者；默认不加载语音或模型。
 */
export async function startRuntime(options: RuntimeOptions): Promise<StartedRuntime> {
  const lifecycle = new RuntimeLifecycle();
  lifecycle.transition("starting");
  const log = options.log ?? (() => undefined);
  mkdirSync(options.configDir, { recursive: true });
  const lock = new InstanceLock(join(options.configDir, "runtime.lock"));
  lock.acquire();

  type Cleanup = () => void | Promise<void>;
  const cleanup: {
    http?: Cleanup;
    ws?: Cleanup;
    subscription?: Cleanup;
    assistant?: Cleanup;
    expressions?: Cleanup;
    observations?: Cleanup;
    bridge?: Cleanup;
    memory?: Cleanup;
    audit?: (kind: string, failedStages: string[]) => void;
    database?: Cleanup;
  } = {};
  let stopPromise: Promise<void> | undefined;

  async function release(startupFailed: boolean): Promise<void> {
    lifecycle.transition("stopping");
    const failedStages: string[] = [];
    async function attempt(stage: string, close?: Cleanup): Promise<void> {
      try { await close?.(); }
      catch { failedStages.push(stage); }
    }
    // 先封住入口；WS 必须先断开才能等 HTTP 排空，期间数据库仍供清理使用。
    const httpDrain = attempt("http", cleanup.http);
    await attempt("subscription", cleanup.subscription);
    // 先发起助理取消，避免 WS 断连触发陪伴重新调度。
    const stoppingAssistant = attempt("assistant", cleanup.assistant);
    const closingBridge = attempt("bridge", cleanup.bridge);
    await attempt("ws", cleanup.ws);
    await stoppingAssistant;
    await attempt("expressions", cleanup.expressions);
    await attempt("observations", cleanup.observations);
    await httpDrain;
    await closingBridge;
    await attempt("memory", cleanup.memory);
    const kind = startupFailed ? "runtime.start_failed" : failedStages.length ? "runtime.stop_failed" : "runtime.stopped";
    await attempt("audit", () => cleanup.audit?.(kind, [...failedStages]));
    await attempt("database", cleanup.database);
    await attempt("lock", () => lock.release());
    lifecycle.transition("stopped");
    if (failedStages.length && !startupFailed) await attempt("host", options.onShutdownError);
    if (failedStages.length || !startupFailed) {
      await attempt("log", () => log(failedStages.length
        ? `runtime cleanup failed: ${failedStages.join(", ")}`
        : "maneki runtime stopped cleanly"));
    }
    if (failedStages.length) throw new Error(`runtime cleanup failed: ${failedStages.join(", ")}`);
  }

  try {
    const store = new RuntimeStore(join(options.configDir, "runtime.db"));
    cleanup.database = () => store.close();
    const { config } = loadRuntimeConfig(options.configDir);

    const storedId = store.kvGet("instanceId");
    const instanceId = storedId || `rt-${generateToken().slice(0, 12)}`;
    if (!storedId) store.kvSet("instanceId", instanceId);
    cleanup.audit = (kind, failedStages) => store.audit(kind, instanceId, failedStages.length ? { failedStages } : {}, new Date().toISOString());

    const root = ensureRootToken(options.configDir, store);

    const feed = new EventFeed();
    const speechHost = new SpeechHostBroker((id) => {
      const client = store.findClient(id);
      return Boolean(client && !client.revokedAt && client.scopes.includes("speech_host"));
    }, Date.now, { get: () => store.kvGet("speechHostUnsettled"), set: (value) => store.kvSet("speechHostUnsettled", value) });
    const expressions = new ExpressionStateFeed({
      active: (clientId) => {
        const client = store.findClient(clientId);
        return client != null && !client.revokedAt;
      },
      publish: (state) => feed.publish("expression.state", { state }),
    });
    cleanup.expressions = () => expressions.close();
    const dnd = {
      get: (): boolean => store.kvGet("dnd") === "1",
      set: (value: boolean): void => {
        store.kvSet("dnd", value ? "1" : "0");
      },
    };
    const observations = new SessionObservations({
      active: (clientId) => {
        const client = store.findClient(clientId);
        return Boolean(client && !client.revokedAt);
      },
      publish: () => feed.publish("assistant.observations_changed"),
    });
    cleanup.observations = () => observations.close();
    const notifications = new NotificationBudget(config.limits.maxNotificationsPerHour);
    const quotaPolicy = new DailyQuotaPolicy(
      {
        proactiveDailyTokenLimit: config.limits.proactiveDailyTokenLimit,
        interactiveDailyTokenLimit: config.limits.interactiveDailyTokenLimit,
      },
      store.asQuotaLedger(),
      () => new Date(),
    );
    const assistant = new AssistantService({
      store: store.assistantStore(), configDir: options.configDir, feed, quota: quotaPolicy,
      notifications, notifier: options.notifier ?? new WindowsSystemNotifier(),
      dnd: () => dnd.get(),
      active: (client) => {
        const row = store.findClient(client);
        return Boolean(row && !row.revokedAt);
      },
      expressionState: () => expressions.current(),
      observations: () => observations.snapshot(),
      ...(options.chatProvider ? { provider: options.chatProvider } : {}),
      ...(options.assistantMemory ? { memory: options.assistantMemory } : {}),
      speech: { ...options.speech, host: speechHost },
    });
    cleanup.assistant = () => assistant.stop();
    cleanup.subscription = feed.subscribe((event) => {
      if (event.kind === "dnd.changed") { assistant.wake(); assistant.companion?.policyChanged(); }
    });

    // HTTP 签发与 WS 兑换必须共享同一票据发行器，票据才有效。
    const tickets = new TicketIssuer();
    const stop = (): Promise<void> => stopPromise ??= release(false);

    // M2b 派发：配置了 dsh 网关才装配 TaskService（Broker + DshAdapter 派发）。
    let tasks: TaskService | undefined;
    if (config.dsh) {
      const adapter = new (await import("@maneki-pet/adapter-dsh")).DshAdapter({
        gateway: { baseUrl: config.dsh.baseUrl, token: config.dsh.token },
      });
      const broker = new TaskBroker({
        store: store.asBrokerTaskStore(),
        clock: () => new Date(),
        ...(config.broker && Object.keys(config.broker).length > 0 ? { config: { maxRunningPerWorkdir: config.broker.maxRunningPerWorkdir ?? 1, maxQueuedPerWorkdir: config.broker.maxQueuedPerWorkdir ?? 4 } } : {}),
        dispatcher: {
          dispatch: async (task) => {
            await adapter.submit(
              { brokerRequestId: task.brokerRequestId, prompt: task.prompt, target: { kind: "new", workdir: task.workdir } },
              { requestId: task.brokerRequestId, signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 },
            );
          },
        },
      });
      tasks = new TaskService(broker);
      feed.publish("tasks.configured", { adapter: "dsh", gateway: config.dsh.baseUrl });
    }

    let companion: CompanionService | undefined;
    const hub = new WsHub({
      onConnectionClosed: (connectionId) => companion?.connectionClosed(connectionId),
      tickets,
      feed,
      clientScopes: (clientId) => {
        const client = store.findClient(clientId);
        return client && !client.revokedAt ? client.scopes : undefined;
      },
      originAllowlist: options.originAllowlist ?? [],
      log,
      ...(options.wsAuthTimeoutMs !== undefined ? { authTimeoutMs: options.wsAuthTimeoutMs } : {}),
    });
    cleanup.ws = () => hub.detach();
    const companionLeases = new CompanionLeases({
      runtimeEpoch: hub.runtimeEpoch,
      now: Date.now, mono: () => performance.now(),
      scopes: (clientId) => { const c=store.findClient(clientId); return c&&!c.revokedAt?c.scopes:undefined; },
      ownsConnection: (clientId, connectionId) => hub.ownsConnection(clientId, connectionId),
      policyRevision: () => companion?.policyRevision() ?? 0,
    });
    companion = new CompanionService({
      store: new CompanionStore(store.assistantStore()), leases: companionLeases,
      feed, runtimeEpoch: hub.runtimeEpoch, settings: () => readAssistantSettings(store.assistantStore()),
      historyEpoch: () => store.assistantStore().epoch(), dnd: () => dnd.get(),
    });
    assistant.companion = companion;
    const api = new LocalHttpApi({
      host: "127.0.0.1",
      port: options.port ?? 0,
      store,
      tickets,
      originAllowlist: options.originAllowlist ?? [],
      instanceId,
      version: options.version ?? RELEASE_VERSION,
      rootToken: root.token,
      config,
      quotaPolicy,
      notifications,
      feed,
      expressions,
      observations,
      dnd,
      assistant,
      speechHost,
      ...(tasks ? { tasks } : {}),
      onClientRevoked: (clientId) => {
        speechHost.revoke(clientId);
        assistant.cancelClient(clientId);
        companion?.revoke(clientId);
        hub.revokeClient(clientId);
        expressions.current();
      },
      onShutdown: () => {
        // HTTP 接受退出后，release 负责记录故障并通知宿主。
        void stop().catch(() => undefined);
      },
    });
    cleanup.http = () => api.stop();
    const { port } = await api.start();
    hub.attach(api.rawServer);

    const sinks: ExpressionSinks = {
      say: (text, mood) => feed.publish("expression.say", { text, mood }),
      setState: (state) => {
        // stdio 桥只有表达能力；内部来源仅用于租约归属，不授予 MCP 管理权限。
        if (!expressions.update("root", "mcp-stdio", state as PetState)) throw new Error("expression source limit reached");
      },
      play: (action) => feed.publish("expression.play", { action }),
      notify: (title, body, urgency) => feed.publish("notification.sent", { title, body, urgency }),
    };
    const bridge = new McpExpressionBridge({
      sinks,
      dndBlocked: () => dnd.get(),
      channelEnabled: () => true,
      notifications,
    });
    cleanup.bridge = () => bridge.close();

    // 外挂记忆（票据 #46）：配置了 stdio 启动命令才创建；客户端按需拉起服务进程，
    // 关闭/故障降级由 Core MemoryContextService 承担，不影响提醒与派发。
    let memoryService: MemoryContextService | undefined;
    if (config.externalMemory) {
      const external = config.externalMemory;
      const memoryClient = new McpMemoryClient({
        command: external.command,
        ...(external.args ? { args: external.args } : {}),
        ...(external.searchTool ? { searchTool: external.searchTool } : {}),
        ...(external.writeTool ? { writeTool: external.writeTool } : {}),
        ...(external.providerId ? { providerId: external.providerId } : {}),
      });
      cleanup.memory = () => memoryClient.stop();
      memoryService = new MemoryContextService({ provider: memoryClient });
    }

    lifecycle.transition("ready");
    feed.publish("runtime.ready", { port, instanceId });
    store.audit("runtime.started", instanceId, { port }, new Date().toISOString());
    log(`maneki runtime ready: port=${port} instanceId=${instanceId}`);

    let mcpStarted = false;
    return {
      assistant,
      port,
      instanceId,
      rootToken: root.token,
      rootTokenPath: root.path,
      feed,
      store,
      ...(memoryService ? { memory: memoryService } : {}),
      ...(tasks ? { tasks } : {}),
      state: () => lifecycle.state,
      startMcpStdioBridge: async () => {
        if (stopPromise) throw new Error("runtime stopping");
        if (mcpStarted) {
          return;
        }
        mcpStarted = true;
        await bridge.connectStdio();
        log("mcp stdio bridge connected");
      },
      stop,
    };
  } catch (error) {
    // release 已记录脱敏的回滚故障；调用方仍需原始启动失败（例如不支持的库版本）。
    stopPromise ??= release(true);
    await stopPromise.catch(() => undefined);
    throw error;
  }
}

/** 根令牌：首次启动生成并写入用户私有权限文件；凭据不进配置与数据库明文。 */
function ensureRootToken(configDir: string, store: RuntimeStore): { token: string; path: string } {
  const path = join(configDir, "root-token");
  let token: string;
  if (existsSync(path)) {
    token = readFileSync(path, "utf8").trim();
  } else {
    token = generateToken();
    writeFileSync(path, `${token}\n`, "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 上 chmod 语义有限；尽力而为，权限边界由用户目录 ACL 承担。
    }
  }
  if (!store.findClient("root")) {
    store.createClient({
      clientId: "root",
      name: "root",
      tokenHash: hashToken(token),
      scopes: ["admin"],
      createdAt: new Date().toISOString(),
    });
  }
  return { token, path };
}
