import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_REMINDER_ID_PATTERN,
  AGENT_REMINDER_UUID_PATTERN,
  MAX_AGENT_REMINDER_LIST_ITEMS,
  MAX_BRIEFING_ITEMS,
  validTimeZone,
  type AgentReminderReceipt,
  type AgentReminderSummary,
  type WorkBriefing,
} from "@maneki-pet/core";
import type { PersonalTodo, PersonalReminder } from "@maneki-pet/core";
import type { CompanionReference } from "@maneki-pet/core";
import { CompanionReferences } from "./companion-references.js";
import { AssistantError, defaultAssistantSettings } from "./assistant-settings.js";

export const MEMORY_WRITE_UNKNOWN_NOTICE = "此次保存结果未知，请到 EverNook 核实；不会自动重试。";
const MAX_AGENT_REMINDERS_PER_HOUR = 30;

interface AgentReminderRow extends AgentReminderSummary {
  status: PersonalReminder["status"];
  attempts: number;
  requestId: string;
  hash: string;
  result: string;
}

function hasCreationReceipt(row: AgentReminderRow): boolean {
  if (typeof row.requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(row.requestId) ||
      !AGENT_REMINDER_UUID_PATTERN.test(row.reminderId) || typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash) ||
      typeof row.result !== "string") return false;
  // SQL 已过滤无法解析的 JSON；保留旧版创建回执的完整格式，拒绝其它 mutation 或残缺回执。
  const receipt = JSON.parse(row.result) as Partial<AgentReminderReceipt>;
  return receipt.requestId === row.requestId && receipt.reminderId === row.reminderId &&
    typeof receipt.remindAt === "number" && Number.isSafeInteger(receipt.remindAt) && receipt.remindAt > 0 &&
    row.result === JSON.stringify({ requestId: row.requestId, reminderId: row.reminderId, remindAt: receipt.remindAt });
}

export const ASSISTANT_SCHEMA = `
CREATE TABLE assistant_todos(id TEXT PRIMARY KEY,title TEXT NOT NULL,notes TEXT NOT NULL,due_date TEXT,completed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE assistant_reminders(id TEXT PRIMARY KEY,todo_id TEXT UNIQUE REFERENCES assistant_todos(id) ON DELETE CASCADE,message TEXT NOT NULL,remind_at INTEGER NOT NULL,time_zone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,code TEXT,version INTEGER NOT NULL DEFAULT 1,delivery_id TEXT);
CREATE INDEX assistant_reminders_due ON assistant_reminders(status,remind_at);
CREATE TABLE assistant_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,epoch INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE assistant_requests(client_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,user_seq INTEGER,reply_seq INTEGER,code TEXT,PRIMARY KEY(client_id,request_id));
CREATE TABLE assistant_mutations(client_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(client_id,request_id));
`;
export interface AssistantMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  companionReference?: CompanionReference;
  companionReferenceUnavailable?: true;
}
export interface ChatRequest {
  client_id: string;
  request_id: string;
  hash: string;
  epoch: number;
  status: string;
  user_seq: number | null;
  reply_seq: number | null;
  code: string | null;
}

/** 与 RuntimeStore 复用同一个 SQLite 连接；不创建第二个数据库拥有者。 */
export class AssistantStore {
  constructor(private readonly db: DatabaseSync) {}
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(key: string): string | null {
    return (
      (
        this.db
          .prepare("SELECT value FROM runtime_kv WHERE key=?")
          .get(`assistant.${key}`) as { value: string } | undefined
      )?.value ?? null
    );
  }
  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO runtime_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`assistant.${key}`, value);
  }
  clearCompanionReferences(): void {
    this.db.prepare("DELETE FROM runtime_kv WHERE key GLOB 'assistant.companion.reference.*'").run();
  }
  pruneCompanionReferences(): void {
    const prefix = "assistant.companion.reference.";
    const page = this.db.prepare("SELECT key,CASE WHEN length(value)<=2048 THEN value ELSE NULL END AS value FROM runtime_kv WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT 128");
    const message = this.db.prepare("SELECT 1 FROM assistant_messages WHERE seq=? AND epoch=? AND role='user'");
    const remove = this.db.prepare("DELETE FROM runtime_kv WHERE key=?");
    const currentEpoch = this.epoch();
    let after = "";
    for (;;) {
      const rows = page.all(prefix, `${prefix}\uffff`, after) as Array<{key:string; value:string|null}>;
      if (!rows.length) break;
      for (const row of rows) {
        after = row.key;
        const match = /^assistant\.companion\.reference\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(row.key);
        if (!match) continue;
        const epoch = Number(match[1]), seq = Number(match[2]);
        if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) continue;
        if (row.value === null) continue;
        let value: unknown;
        try { value = JSON.parse(row.value); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const fields = ["formatVersion", "epoch", "userSeq", "utteranceId", "text", "mode", "createdAt"];
        if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)) ||
            record.formatVersion !== 1 || record.epoch !== epoch || record.userSeq !== seq ||
            typeof record.utteranceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.utteranceId) ||
            typeof record.text !== "string" || record.text.length === 0 || record.text.length > 80 ||
            (record.mode !== "automatic" && record.mode !== "manual") ||
            !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0 || Number(record.createdAt) > 253402300799999) continue;
        if (epoch !== currentEpoch || !message.get(seq, epoch)) remove.run(row.key);
      }
      if (rows.length < 128) break;
    }
  }
  hasUnverifiableReferenceGap(after: number, before: number): boolean {
    const epoch = this.epoch();
    for (const seq of this.companionReferenceSeqsBetween(after, before - 1)) {
      try { new CompanionReferences(this).get(epoch, seq); }
      catch (error) {
        if (error instanceof AssistantError && error.code === "companion_state_unavailable") return true;
        throw error;
      }
    }
    return false;
  }
  *companionReferenceSeqsBetween(after: number, through: number): IterableIterator<number> {
    // 按当前 epoch 的 KV 主键前缀分页；没有引用时不扫描普通消息历史。
    const epoch = this.epoch();
    const prefix = `assistant.companion.reference.${epoch}.`;
    const page = this.db.prepare("SELECT key FROM runtime_kv WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT 128");
    const user = this.db.prepare("SELECT 1 FROM assistant_messages WHERE seq=? AND epoch=? AND role='user'");
    let cursor = "";
    for (;;) {
      const rows = page.all(prefix, `${prefix}\uffff`, cursor) as Array<{key:string}>;
      for (const row of rows) {
        cursor = row.key;
        const suffix = row.key.slice(prefix.length);
        if (!/^(0|[1-9]\d*)$/.test(suffix)) continue;
        const seq = Number(suffix);
        if (Number.isSafeInteger(seq) && seq > after && seq <= through && user.get(seq, epoch)) yield seq;
      }
      if (rows.length < 128) return;
    }
  }
  epoch(): number {
    return Number(this.get("epoch") ?? 0);
  }
  messageCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM assistant_messages WHERE epoch=?",
        )
        .get(this.epoch()) as { count: number }
    ).count;
  }
  revision(): number {
    return Number(this.get("revision") ?? 0);
  }
  changed(): void {
    this.set("revision", String(this.revision() + 1));
  }
  todos(): PersonalTodo[] {
    return this.db
      .prepare(
        "SELECT id,title,notes,due_date AS dueDate,completed,version,created_at AS createdAt,updated_at AS updatedAt FROM assistant_todos ORDER BY created_at DESC,id LIMIT 200",
      )
      .all()
      .map((row) => ({
        ...row,
        completed: row.completed === 1,
      })) as unknown as PersonalTodo[];
  }
  briefingTimeZone(): string {
    // 单独投影时区，模型配置、记忆路径和凭证引用均不离开 SQLite。
    const row = this.db.prepare(
      "SELECT json_extract(value, '$.timeZone') AS zone FROM runtime_kv WHERE key='assistant.settings'",
    ).get();
    if (!row) return defaultAssistantSettings().timeZone;
    if (typeof row.zone !== "string" || !validTimeZone(row.zone)) throw new AssistantError(503, "settings_invalid");
    return row.zone;
  }
  dueTodos(date: string): Pick<WorkBriefing, "todos" | "moreTodos"> {
    const rows = this.db.prepare(
      "SELECT title,due_date AS dueDate FROM assistant_todos WHERE completed=0 AND due_date<=? ORDER BY due_date,id LIMIT ?",
    ).all(date, MAX_BRIEFING_ITEMS + 1) as WorkBriefing["todos"];
    return { todos: rows.slice(0, MAX_BRIEFING_ITEMS), moreTodos: rows.length > MAX_BRIEFING_ITEMS };
  }
  todo(id: string): PersonalTodo | undefined {
    return this.todos().find((item) => item.id === id);
  }
  saveTodo(item: PersonalTodo): void {
    this.db
      .prepare(
        "INSERT INTO assistant_todos VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,due_date=excluded.due_date,completed=excluded.completed,version=excluded.version,updated_at=excluded.updated_at",
      )
      .run(
        item.id,
        item.title,
        item.notes,
        item.dueDate,
        Number(item.completed),
        item.version,
        item.createdAt,
        item.updatedAt,
      );
    if (item.completed)
      this.db
        .prepare(
          "UPDATE assistant_reminders SET status='cancelled',version=version+1 WHERE todo_id=? AND status='pending'",
        )
        .run(item.id);
  }
  deleteTodo(id: string): void {
    this.db.prepare("DELETE FROM assistant_todos WHERE id=?").run(id);
  }
  reminders(): PersonalReminder[] {
    return this.db
      .prepare(
        "SELECT id,todo_id AS todoId,message,remind_at AS remindAt,time_zone AS timeZone,status,attempts,code,version,seen_at AS seenAt FROM assistant_reminders ORDER BY remind_at,id LIMIT 200",
      )
      .all() as unknown as PersonalReminder[];
  }
  reminder(id: string): PersonalReminder | undefined {
    return this.reminders().find((item) => item.id === id);
  }
  private agentReminderRows(creatorId: string, id?: string): Iterable<AgentReminderRow> {
    // 先用 mutation 主键前缀限定来源，再用回执中的 UUID 与提醒主键关联。
    // 失效回执不参与关联。查询只看未认领的提醒，写操作需区分不存在与已认领。
    return this.db.prepare(`
      SELECT r.id AS reminderId, r.message, r.remind_at AS remindAt, r.version, r.status, r.attempts,
        m.request_id AS requestId, m.hash, m.result
      FROM assistant_mutations m
      JOIN assistant_reminders r ON r.id=CASE WHEN json_valid(m.result) THEN json_extract(m.result,'$.reminderId') END
      WHERE m.client_id=? AND ${id === undefined ? "r.status='pending' AND r.attempts=0" : "r.id=?"}
      ORDER BY r.remind_at,r.id
    `).iterate(creatorId, ...(id === undefined ? [] : [id])) as unknown as Iterable<AgentReminderRow>;
  }
  listAgentReminders(creatorId: string): AgentReminderSummary[] {
    const reminders = new Map<string, AgentReminderSummary>();
    for (const row of this.agentReminderRows(creatorId)) {
      if (!hasCreationReceipt(row)) continue;
      const { reminderId, message, remindAt, version } = row;
      reminders.set(reminderId, { reminderId, message, remindAt, version });
      if (reminders.size >= MAX_AGENT_REMINDER_LIST_ITEMS) break;
    }
    return [...reminders.values()];
  }
  agentReminderTarget(creatorId: string, id: string): Pick<AgentReminderRow, "version" | "status" | "attempts"> | undefined {
    for (const row of this.agentReminderRows(creatorId, id)) {
      if (hasCreationReceipt(row)) return { version: row.version, status: row.status, attempts: row.attempts };
    }
    return undefined;
  }
  saveReminder(item: PersonalReminder): void {
    this.db
      .prepare(
        "INSERT INTO assistant_reminders(id,todo_id,message,remind_at,time_zone,status,attempts,code,version) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message,remind_at=excluded.remind_at,time_zone=excluded.time_zone,status=excluded.status,code=excluded.code,version=excluded.version,delivery_id=NULL",
      )
      .run(
        item.id,
        item.todoId,
        item.message,
        item.remindAt,
        item.timeZone,
        item.status,
        item.attempts,
        item.code,
        item.version,
      );
  }
  deleteReminder(id: string): void {
    this.db.prepare("DELETE FROM assistant_reminders WHERE id=?").run(id);
  }
  rescheduleReminder(id: string, remindAt: number): void {
    this.db.prepare("UPDATE assistant_reminders SET remind_at=?,version=version+1 WHERE id=?").run(remindAt, id);
  }
  acknowledgeReminder(id: string, seenAt: number): void {
    this.db
      .prepare(
        "UPDATE assistant_reminders SET seen_at=?,version=version+1 WHERE id=? AND seen_at IS NULL AND status IN ('accepted','failed')",
      )
      .run(seenAt, id);
  }
  retryReminder(id: string): void {
    this.db
      .prepare(
        "UPDATE assistant_reminders SET status='pending',code=NULL,seen_at=NULL,delivery_id=NULL,version=version+1 WHERE id=? AND status='failed'",
      )
      .run(id);
  }
  nextDue(): number | null {
    return (
      this.db
        .prepare(
          "SELECT MIN(remind_at) AS time FROM assistant_reminders WHERE status='pending'",
        )
        .get() as { time: number | null }
    ).time;
  }
  due(now: number): PersonalReminder[] {
    return this.reminders().filter(
      (r) => r.status === "pending" && r.remindAt <= now,
    );
  }
  deliveryId(id: string): string | null {
    return (
      (
        this.db
          .prepare(
            "SELECT delivery_id AS id FROM assistant_reminders WHERE id=?",
          )
          .get(id) as { id: string | null } | undefined
      )?.id ?? null
    );
  }
  claim(id: string, deliveryId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE assistant_reminders SET status='sending',attempts=attempts+1,version=version+1,delivery_id=? WHERE id=? AND status='pending'",
        )
        .run(deliveryId, id).changes === 1
    );
  }
  finishDelivery(
    id: string,
    status: "accepted" | "failed",
    code: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE assistant_reminders SET status=?,code=?,version=version+1 WHERE id=? AND status='sending'",
      )
      .run(status, code, id);
    this.changed();
  }
  recover(): void {
    this.db.exec(
      "UPDATE assistant_voice_requests SET status=CASE WHEN EXISTS(SELECT 1 FROM assistant_requests r WHERE r.client_id=assistant_voice_requests.client_id AND r.request_id=assistant_voice_requests.request_id) THEN 'submitted' ELSE 'failed' END,code=CASE WHEN EXISTS(SELECT 1 FROM assistant_requests r WHERE r.client_id=assistant_voice_requests.client_id AND r.request_id=assistant_voice_requests.request_id) THEN NULL ELSE 'runtime_restarted' END WHERE status IN ('pending','recognized')",
    );
    this.db
      .prepare(
        "UPDATE assistant_reminders SET status='pending' WHERE status='sending'",
      )
      .run();
    this.transaction(() => {
      // 只恢复当前历史中的在途保存；清过历史的请求不能重建正文或提示。
      const pending = this.db.prepare(
        "SELECT client_id,request_id FROM assistant_requests WHERE status='pending' AND epoch=? AND code IN ('memory_write_pending','memory_write_unknown')",
      ).all(this.epoch()) as Array<{client_id:string;request_id:string}>;
      for (const request of pending) {
        const seq = this.append("assistant", MEMORY_WRITE_UNKNOWN_NOTICE);
        this.settleRequest(request.client_id, request.request_id, "failed", seq, "memory_write_unknown");
      }
      if (pending.length) this.changed();
    });
    this.db
      .prepare(
        "UPDATE assistant_requests SET status='failed',code=CASE WHEN code IN ('memory_write_pending','memory_write_unknown') THEN 'memory_write_unknown' ELSE 'runtime_restarted' END WHERE status='pending'",
      )
      .run();
  }
  messages(before = Number.MAX_SAFE_INTEGER, limit = 50): AssistantMessage[] {
    return (
      this.db
        .prepare(
          "SELECT seq,role,text,created_at AS createdAt FROM assistant_messages WHERE epoch=? AND seq<? ORDER BY seq DESC LIMIT ?",
        )
        .all(this.epoch(), before, limit) as unknown as AssistantMessage[]
    ).reverse().map((row) => this.withCompanionReference(row));
  }
  private withCompanionReference(row: AssistantMessage): AssistantMessage {
    if (row.role !== "user") return row;
    try {
      const reference = new CompanionReferences(this).get(this.epoch(), row.seq);
      return reference ? { ...row, companionReference: reference } : row;
    } catch (error) {
      if (error instanceof AssistantError && error.code === "companion_state_unavailable")
        return { ...row, companionReferenceUnavailable: true };
      throw error;
    }
  }
  message(seq: number | null): AssistantMessage | null {
    const row = seq === null ? null : ((this.db
          .prepare(
            "SELECT seq,role,text,created_at AS createdAt FROM assistant_messages WHERE seq=? AND epoch=?",
          )
          .get(seq, this.epoch()) as unknown as AssistantMessage | undefined) ??
          null);
    return row ? this.withCompanionReference(row) : null;
  }
  append(role: "user" | "assistant", text: string): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO assistant_messages(epoch,role,text,created_at) VALUES(?,?,?,?)",
        )
        .run(this.epoch(), role, text, new Date().toISOString())
        .lastInsertRowid,
    );
  }
  request(client: string, id: string): ChatRequest | undefined {
    return this.db
      .prepare(
        "SELECT * FROM assistant_requests WHERE client_id=? AND request_id=?",
      )
      .get(client, id) as unknown as ChatRequest | undefined;
  }
  createRequest(
    client: string,
    id: string,
    hash: string,
    userSeq: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO assistant_requests(client_id,request_id,hash,epoch,status,user_seq) VALUES(?,?,?,?,'pending',?)",
      )
      .run(client, id, hash, this.epoch(), userSeq);
  }
  settleRequest(
    client: string,
    id: string,
    status: string,
    replySeq: number | null,
    code: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE assistant_requests SET status=?,reply_seq=?,code=? WHERE client_id=? AND request_id=? AND status='pending' AND epoch=?",
      )
      .run(status, replySeq, code, client, id, this.epoch());
  }
  /** 调用外部保存前持久化；进程中断后不能把未获回执误当作未写入。 */
  markMemoryWritePending(client: string, id: string): void {
    const result = this.db.prepare(
      "UPDATE assistant_requests SET code='memory_write_pending' WHERE client_id=? AND request_id=? AND status='pending' AND epoch=?",
    ).run(client, id, this.epoch());
    if (result.changes !== 1) throw new AssistantError(409, "request_not_pending");
  }
  mutation(
    client: string,
    id: string,
  ): { hash: string; result: string } | undefined {
    return this.db
      .prepare(
        "SELECT hash,result FROM assistant_mutations WHERE client_id=? AND request_id=?",
      )
      .get(client, id) as { hash: string; result: string } | undefined;
  }
  /** 与提醒和回执共用事务。回拨时创建沿用已记账小时，改期拒绝新请求。 */
  consumeAgentReminderQuota(operation: "creation" | "reschedule", client: string, now: number): void {
    const key = operation === "creation" ? `reminderCreationQuota.${client}` : `reminderRescheduleQuota.${client}`;
    const hour = Math.floor(now / 3_600_000);
    const saved = this.get(key);
    let previous = { hour, count: 0 };
    if (saved !== null) {
      try { previous = JSON.parse(saved); }
      catch { throw new AssistantError(503, "reminder_quota_unavailable"); }
    }
    if (!previous || !Number.isSafeInteger(previous.hour) || !Number.isInteger(previous.count) ||
        previous.count < 0 || previous.count > MAX_AGENT_REMINDERS_PER_HOUR) throw new AssistantError(503, "reminder_quota_unavailable");
    const count = hour > previous.hour ? 0 : previous.count;
    if (count >= MAX_AGENT_REMINDERS_PER_HOUR || (operation === "reschedule" && hour < previous.hour)) {
      throw new AssistantError(429, `reminder_${operation}_quota`);
    }
    this.set(key, JSON.stringify({ hour: Math.max(hour, previous.hour), count: count + 1 }));
  }
  rememberMutation(
    client: string,
    id: string,
    hash: string,
    result: unknown,
  ): void {
    this.db
      .prepare("INSERT INTO assistant_mutations VALUES(?,?,?,?)")
      .run(client, id, hash, JSON.stringify(result));
  }
  clearHistory(): void {
    this.clearCompanionReferences();
    this.set("epoch", String(this.epoch() + 1));
    this.db.exec(
      "DELETE FROM assistant_messages; UPDATE assistant_requests SET status='cleared',user_seq=NULL,reply_seq=NULL,code=CASE WHEN code IN ('memory_write_pending','memory_write_unknown') THEN 'memory_write_unknown' ELSE 'history_cleared' END; UPDATE assistant_voice_requests SET status='cleared',code='history_cleared'; DELETE FROM runtime_kv WHERE key='assistant.summary';",
    );
    this.changed();
  }
  clearTodos(): void {
    this.db.exec("DELETE FROM assistant_todos");
    this.changed();
  }
  voiceRequest(
    client: string,
    id: string,
  ):
    | { hash: string; epoch: number; status: string; code: string | null }
    | undefined {
    return this.db
      .prepare(
        "SELECT hash,epoch,status,code FROM assistant_voice_requests WHERE client_id=? AND request_id=?",
      )
      .get(client, id) as
      | { hash: string; epoch: number; status: string; code: string | null }
      | undefined;
  }
  createVoiceRequest(client: string, id: string, hash: string): void {
    this.db
      .prepare(
        "INSERT INTO assistant_voice_requests VALUES(?,?,?,?,'pending',NULL)",
      )
      .run(client, id, hash, this.epoch());
  }
  settleVoiceRequest(
    client: string,
    id: string,
    status: string,
    code: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE assistant_voice_requests SET status=?,code=? WHERE client_id=? AND request_id=? AND status IN ('pending','recognized')",
      )
      .run(status, code, client, id);
  }
}
