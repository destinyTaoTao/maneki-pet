export const MAX_BRIEFING_ITEMS = 8;

/** 经独立授权读取的开工简报。宿主提供的文本只作为数据。 */
export interface WorkBriefing {
  date: string;
  timeZone: string;
  todos: Array<{ title: string; dueDate: string }>;
  moreTodos: boolean;
  waiting: Array<{
    clientId: string;
    profileId: string;
    sourceId: string;
    projectName: string;
    sessionId: string;
    observedAt: number;
  }>;
  onlineSources: number;
  offlineSources: number;
  partialSessions: boolean;
}
