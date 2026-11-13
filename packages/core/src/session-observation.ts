export const sessionPhases = ["thinking", "working", "waiting_input", "completed", "failed", "cancelled"] as const;
export type SessionPhase = typeof sessionPhases[number];
export interface ObservedSession {
  sessionId: string;
  projectName: string;
  phase: SessionPhase;
  sequence: number;
  observedAt: number;
}
export interface SessionObservationSource {
  clientId: string;
  sourceId: string;
  profileId: string;
  connected: boolean;
  truncated: boolean;
  lastSeenAt: number;
  sessions: ObservedSession[];
}
export const sessionPhaseText: Record<SessionPhase, string> = {
  thinking: "思考中", working: "工作中", waiting_input: "等待你回应",
  completed: "已完成", failed: "失败", cancelled: "已取消",
};

/** 对话和视图复用的只读说明，每条来源信息均按数据转义。 */
export function describeObservedSessions(sources: SessionObservationSource[], waitingOnly = false): string {
  if (!sources.length) return "尚未观察到 dsh 来源。请连接插件并在 dsh 中打开会话。";
  const lines: string[] = [];
  for (const source of sources) {
    const origin = `${JSON.stringify(source.profileId)} / ${source.sourceId}（客户端 ${source.clientId}）`;
    if (!source.connected) {
      lines.push(`${origin}：来源已失联，当前进度不可用，最后联系 ${new Date(source.lastSeenAt).toISOString()}。`);
      if (!waitingOnly) {
        for (const row of source.sessions)
          lines.push(`${JSON.stringify(row.projectName || "目录未知")} / ${row.sessionId}：上次观测为${sessionPhaseText[row.phase]}，${new Date(row.observedAt).toISOString()}，当前状态未知。`);
      }
      continue;
    }
    const sessions = waitingOnly ? source.sessions.filter((row) => row.phase === "waiting_input") : source.sessions;
    if (!source.sessions.length) lines.push(`${origin}：已连接，尚未观察到会话。`);
    for (const row of sessions) {
      lines.push(`${origin} / ${JSON.stringify(row.projectName || "目录未知")} / ${row.sessionId}：${sessionPhaseText[row.phase]}，最后观测 ${new Date(row.observedAt).toISOString()}。`);
    }
    if (source.truncated) lines.push(`${origin}：会话超过观察上限，部分未展示。`);
  }
  if (!lines.length) return "当前没有已确认正在等待你回应的会话。";
  return lines.slice(0, 20).join("\n") + (lines.length > 20 ? "\n仅显示前 20 项，请在 dsh 核查其余会话。" : "");
}

export function sessionProgressReply(input: string, sources: SessionObservationSource[]): string | null {
  const query = input.trim().replace(/[？?。！!]$/, "");
  if (query === "查看会话进度" || query === "查看会话") return describeObservedSessions(sources);
  if (query === "哪个会话在等我" || query === "哪个会话在等输入") return describeObservedSessions(sources, true);
  return null;
}
