import type { DatabaseSync } from "node:sqlite";
import type { PersonalTodo, PersonalReminder } from "@maneki-pet/core";

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
        "SELECT id,todo_id AS todoId,message,remind_at AS remindAt,time_zone AS timeZone,status,attempts,code,version FROM assistant_reminders ORDER BY remind_at,id LIMIT 200",
      )
      .all() as unknown as PersonalReminder[];
  }
  reminder(id: string): PersonalReminder | undefined {
    return this.reminders().find((item) => item.id === id);
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
    this.db
      .prepare(
        "UPDATE assistant_reminders SET status='pending' WHERE status='sending'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE assistant_requests SET status='failed',code='runtime_restarted' WHERE status='pending'",
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
    ).reverse();
  }
  message(seq: number | null): AssistantMessage | null {
    return seq === null
      ? null
      : ((this.db
          .prepare(
            "SELECT seq,role,text,created_at AS createdAt FROM assistant_messages WHERE seq=? AND epoch=?",
          )
          .get(seq, this.epoch()) as unknown as AssistantMessage | undefined) ??
          null);
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
    this.set("epoch", String(this.epoch() + 1));
    this.db.exec(
      "DELETE FROM assistant_messages; UPDATE assistant_requests SET status='cleared',user_seq=NULL,reply_seq=NULL,code='history_cleared'; DELETE FROM runtime_kv WHERE key='assistant.summary';",
    );
    this.changed();
  }
  clearTodos(): void {
    this.db.exec("DELETE FROM assistant_todos");
    this.changed();
  }
}
