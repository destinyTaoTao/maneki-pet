import { MAX_BRIEFING_ITEMS, validDateOnly, validTimeZone, type WorkBriefing } from "@maneki-pet/core";
import { BriefingClientError, createPairedTransport, type PairedClientOptions } from "./paired-transport.js";

export type BriefingClientOptions = PairedClientOptions;

function hasFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTodo(row: unknown): row is WorkBriefing["todos"][number] {
  return hasFields(row, ["title", "dueDate"]) &&
    typeof row.title === "string" && row.title.trim().length > 0 && row.title.length <= 200 &&
    typeof row.dueDate === "string" && validDateOnly(row.dueDate);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validWaiting(row: unknown): row is WorkBriefing["waiting"][number] {
  return hasFields(row, ["clientId", "profileId", "sourceId", "projectName", "sessionId", "observedAt"]) &&
    typeof row.clientId === "string" && /^client-[0-9a-f]{12}$/.test(row.clientId) &&
    typeof row.profileId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row.profileId) &&
    typeof row.sourceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.sourceId) &&
    typeof row.projectName === "string" && row.projectName.length <= 80 && !/[\\/\r\n]/.test(row.projectName) &&
    typeof row.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.sessionId) &&
    nonnegativeInteger(row.observedAt);
}

function validWaitingList(rows: unknown, onlineSources: number): boolean {
  if (!Array.isArray(rows) || rows.length > MAX_BRIEFING_ITEMS || !rows.every(validWaiting)) return false;
  const profiles = new Map<string, string>();
  const sessions = new Set<string>();
  let latest = Infinity;
  for (const row of rows) {
    const source = `${row.clientId}/${row.sourceId}`;
    const session = `${source}/${row.sessionId}`;
    if (row.observedAt > latest || sessions.has(session) ||
      (profiles.has(source) && profiles.get(source) !== row.profileId)) return false;
    profiles.set(source, row.profileId);
    sessions.add(session);
    latest = row.observedAt;
  }
  return profiles.size <= onlineSources;
}

function validBriefing(value: unknown): value is WorkBriefing {
  if (!hasFields(value, ["date", "timeZone", "todos", "moreTodos", "waiting", "onlineSources", "offlineSources", "partialSessions"])) return false;
  const { date, timeZone, todos, moreTodos, waiting, onlineSources, offlineSources, partialSessions } = value;
  return typeof date === "string" && validDateOnly(date) &&
    typeof timeZone === "string" && timeZone.length <= 80 && validTimeZone(timeZone) &&
    Array.isArray(todos) && todos.length <= MAX_BRIEFING_ITEMS && todos.every(validTodo) &&
    todos.every((row, i) => row.dueDate <= date && (i === 0 || row.dueDate >= todos[i - 1]!.dueDate)) &&
    typeof moreTodos === "boolean" && (!moreTodos || todos.length === MAX_BRIEFING_ITEMS) &&
    nonnegativeInteger(onlineSources) && nonnegativeInteger(offlineSources) && onlineSources + offlineSources <= 64 &&
    validWaitingList(waiting, onlineSources) && typeof partialSessions === "boolean" && (onlineSources > 0 || !partialSessions);
}

export function createBriefingClient(options: BriefingClientOptions) {
  const exchange = createPairedTransport("briefing", options);
  return {
    async getBriefing(signal?: AbortSignal): Promise<WorkBriefing> {
      const body = await exchange(signal);
      if (!validBriefing(body)) throw new BriefingClientError("Runtime 简报响应格式无效");
      return body;
    },
  };
}
