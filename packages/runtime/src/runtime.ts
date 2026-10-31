import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { DailyQuotaPolicy } from "@maneki-pet/core";

import { generateToken, hashToken, TicketIssuer } from "./auth.js";
import { EventFeed } from "./events.js";
import { LocalHttpApi } from "./http-api.js";
import { InstanceLock, RuntimeLifecycle, type RuntimeState } from "./lifecycle.js";
import { McpExpressionBridge, type ExpressionSinks } from "./mcp-bridge.js";
import { loadRuntimeConfig, NotificationBudget } from "./quota.js";
import { RuntimeStore } from "./store.js";
import { WsHub } from "./ws.js";

export interface RuntimeOptions {
  configDir: string;
  /** 0（默认）= 由操作系统分配临时端口；正式部署用固定配置端口。 */
  port?: number;
  originAllowlist?: string[];
  version?: string;
  log?: (line: string) => void;
  /** WS 鉴权超时（测试可调短）。 */
  wsAuthTimeoutMs?: number;
}

export interface StartedRuntime {
  port: number;
  instanceId: string;
  rootToken: string;
  rootTokenPath: string;
  feed: EventFeed;
  store: RuntimeStore;
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

  let openedStore: RuntimeStore | undefined;
  try {
    const store = new RuntimeStore(join(options.configDir, "runtime.db"));
    openedStore = store;
    const { config } = loadRuntimeConfig(options.configDir);

    let instanceId = store.kvGet("instanceId");
    if (!instanceId) {
      instanceId = `rt-${generateToken().slice(0, 12)}`;
      store.kvSet("instanceId", instanceId);
    }

    const root = ensureRootToken(options.configDir, store);

    const feed = new EventFeed();
    const dnd = {
      get: (): boolean => store.kvGet("dnd") === "1",
      set: (value: boolean): void => {
        store.kvSet("dnd", value ? "1" : "0");
      },
    };
    const notifications = new NotificationBudget(config.limits.maxNotificationsPerHour);
    const quotaPolicy = new DailyQuotaPolicy(
      {
        proactiveDailyTokenLimit: config.limits.proactiveDailyTokenLimit,
        interactiveDailyTokenLimit: config.limits.interactiveDailyTokenLimit,
      },
      store.asQuotaLedger(),
      () => new Date(),
    );

    // HTTP 签发与 WS 兑换必须共享同一票据发行器，票据才有效。
    const tickets = new TicketIssuer();
    let started: StartedRuntime | undefined;
    const api = new LocalHttpApi({
      host: "127.0.0.1",
      port: options.port ?? 0,
      store,
      tickets,
      originAllowlist: options.originAllowlist ?? [],
      instanceId,
      version: options.version ?? "0.1.0",
      rootToken: root.token,
      config,
      quotaPolicy,
      notifications,
      feed,
      dnd,
      onShutdown: () => {
        // 受信管理入口退出：优雅停机，事件循环随服务关闭自然排空。
        void started?.stop();
      },
    });
    const { port } = await api.start();
    const hub = new WsHub({
      tickets,
      feed,
      ...(options.wsAuthTimeoutMs !== undefined ? { authTimeoutMs: options.wsAuthTimeoutMs } : {}),
    });
    hub.attach(api.rawServer);

    const sinks: ExpressionSinks = {
      say: (text, mood) => feed.publish("expression.say", { text, mood }),
      setState: (state) => feed.publish("expression.state", { state }),
      play: (action) => feed.publish("expression.play", { action }),
      notify: (title, body, urgency) => feed.publish("notification.sent", { title, body, urgency }),
    };
    const bridge = new McpExpressionBridge({
      sinks,
      dndBlocked: () => dnd.get(),
      channelEnabled: () => true,
      notifications,
    });

    lifecycle.transition("ready");
    feed.publish("runtime.ready", { port, instanceId });
    store.audit("runtime.started", instanceId, { port, configDir: options.configDir }, new Date().toISOString());
    log(`maneki runtime ready: port=${port} instanceId=${instanceId}`);

    let mcpStarted = false;
    started = {
      port,
      instanceId,
      rootToken: root.token,
      rootTokenPath: root.path,
      feed,
      store,
      state: () => lifecycle.state,
      startMcpStdioBridge: async () => {
        if (mcpStarted) {
          return;
        }
        mcpStarted = true;
        await bridge.connectStdio();
        log("mcp stdio bridge connected");
      },
      stop: async () => {
        if (lifecycle.state !== "ready" && lifecycle.state !== "degraded") {
          return;
        }
        lifecycle.transition("stopping");
        hub.detach();
        await api.stop();
        await bridge.close();
        store.audit("runtime.stopped", instanceId, {}, new Date().toISOString());
        store.close();
        lock.release();
        lifecycle.transition("stopped");
        log("maneki runtime stopped cleanly");
      },
    };
    return started;
  } catch (error) {
    openedStore?.close();
    lock.release();
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
