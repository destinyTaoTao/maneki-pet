/**
 * 对话模型端口（architecture §4.1）：Core 使用与厂商无关的数据，
 * Provider Adapter 转换协议与错误，Runtime 注入实现。
 * 超时（deadlineAtMs）与取消（signal）是两类可区分的终止语义。
 */
export interface CallContext {
  requestId: string;
  signal: AbortSignal;
  deadlineAtMs: number;
}

export type ProviderLocality = "local" | "cloud";

export interface ProviderInfo {
  id: string;
  apiVersion: 1;
  locality: ProviderLocality;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

export interface ChatReplyInput {
  messages: ChatMessage[];
}

export interface ChatReply {
  text: string;
}

export interface ChatProvider {
  info: ProviderInfo;
  reply(input: ChatReplyInput, ctx: CallContext): Promise<ChatReply>;
}
