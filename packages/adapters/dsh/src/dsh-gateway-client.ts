/**
 * dsh web 网关 unary 客户端（2026-10-31 活体探针验证的线协议，审计记录"网关活体派发链路探针"）：
 * POST /api/<endpoint>，body {type:"client-request", rpcId, method, payload:{args:{<参数名>: request}}}，
 * 响应 {type:"server-response", rpcId, result:{ok,value}|{ok:false,error}}。
 * 鉴权 = token 门禁换签名 Cookie（GET /?token= → Set-Cookie，Cookie 名含每实例随机后缀）。
 * 参数名逐方法不同（list=_request、其余=request）——权威来源为生成描述符 parameters[].name。
 */
export interface DshGatewayClientOptions {
  baseUrl: string;
  /** dsh web 门禁 token（启动输出 `?token=…`）。 */
  token: string;
  fetchImpl?: typeof fetch;
}

export type GatewayResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };

export interface SessionListItem {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  cwd: string;
  projections?: { asOfSeq?: number; values?: Record<string, unknown> };
}

export interface TurnOutlineEntry {
  turn: number;
  seq: number;
  prompt: string;
  response: string;
}

export interface SessionProjections {
  asOfSeq?: number;
  values?: {
    title?: string | null;
    tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    turnOutline?: TurnOutlineEntry[];
    userQuestions?: { active?: unknown[]; settled?: unknown[] };
    permissions?: { currentValue?: string };
    workingDirectory?: string;
  };
}

export class DshGatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private cookie: string | undefined;
  private nextRpcId = 1;

  constructor(options: DshGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** token 门禁：GET /?token= → 303 Set-Cookie。 */
  async login(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, {
      redirect: "manual",
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const authCookie = setCookies.find((line) => line.startsWith("dsh-auth-"));
    if (!authCookie) {
      throw new Error(`dsh gateway login failed: no auth cookie (status ${response.status})`);
    }
    this.cookie = authCookie.split(";")[0] ?? "";
  }

  async ensureLogin(): Promise<void> {
    if (!this.cookie) {
      await this.login();
    }
  }

  async call<T>(endpoint: string, method: string, request: unknown, field: string | null): Promise<T> {
    await this.ensureLogin();
    const rpcId = `maneki-${this.nextRpcId}`;
    this.nextRpcId += 1;
    const args = field === null ? request : { [field]: request };
    const response = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
    });
    const body = (await response.json()) as { result?: GatewayResult<T> };
    const result = body.result;
    if (!result) {
      throw new Error(`dsh gateway ${endpoint}: missing result (status ${response.status})`);
    }
    if (!result.ok) {
      throw new Error(`dsh gateway ${endpoint} failed: ${result.error.message} (${result.error.code})`);
    }
    return result.value;
  }

  listSessions(): Promise<{ items: SessionListItem[] }> {
    return this.call("session/list", "session/list", {}, "_request");
  }

  createSession(request: { cwd?: string; sessionId?: string }): Promise<{ sessionId?: string; session?: { sessionId: string } }> {
    return this.call("session/create", "session/create", request, "request");
  }

  prompt(request: {
    sessionId: string;
    requestId: string;
    mode: "queue" | "steer";
    content: Array<{ type: "text"; text: string }>;
    clientTimeZone?: string;
  }): Promise<unknown> {
    return this.call("session/prompt", "session/prompt", request, "request");
  }

  cancelSession(sessionId: string): Promise<{ accepted: true }> {
    return this.call("session/cancel", "session/cancel", { sessionId }, "request");
  }

  projections(sessionId: string): Promise<SessionProjections> {
    return this.call("session/projections", "session/projections", { sessionId }, "request");
  }
}
