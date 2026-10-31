import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { BrokerTask, QuotaLedger, TaskBrokerStore } from "@maneki-pet/core";

export interface ClientRecord {
  clientId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

export type BrokerTaskRow = BrokerTask;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const KNOWN_SCHEMA_VERSION = 2;

/**
 * Runtime 单一 SQLite 拥有者（architecture §6.2）：迁移先备份，
 * 失败停止写入并报错；新版本数据库不交给旧程序盲写。
 */
export class RuntimeStore {
  private readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.migrate();
    } catch (error) {
      // 迁移失败不留下打开的句柄（§6.2：失败停止写入并报错）。
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
      const current = row?.v ?? 0;
      if (current > KNOWN_SCHEMA_VERSION) {
        throw new MigrationError(
          `database schema version ${current} is newer than supported ${KNOWN_SCHEMA_VERSION}; refusing to write`,
        );
      }
      if (current === KNOWN_SCHEMA_VERSION) {
        return;
      }
      if (this.dbPath !== ":memory:") {
        copyFileSync(this.dbPath, `${this.dbPath}.bak-${current}`);
      }
      if (current < 1) {
        this.db.exec(`
          CREATE TABLE clients (
            client_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            scopes TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            detail TEXT NOT NULL
          );
          CREATE TABLE quota_usage (
            day_key TEXT PRIMARY KEY,
            tokens INTEGER NOT NULL
          );
          CREATE TABLE runtime_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
      }
      if (current < 2) {
        this.db.exec(`
          CREATE TABLE broker_tasks (
            broker_request_id TEXT PRIMARY KEY,
            client_request_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            workdir TEXT NOT NULL,
            status TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX broker_tasks_workdir ON broker_tasks (workdir, status);
        `);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
      }
    } catch (error) {
      if (error instanceof MigrationError) {
        throw error;
      }
      throw new MigrationError(`sqlite migration failed: ${describe(error)}`);
    }
  }

  // ---- runtime_kv ----

  kvGet(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM runtime_kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO runtime_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---- clients ----

  createClient(client: Omit<ClientRecord, "revokedAt">): void {
    this.db
      .prepare("INSERT INTO clients (client_id, name, token_hash, scopes, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(client.clientId, client.name, client.tokenHash, JSON.stringify(client.scopes), client.createdAt);
  }

  findClientByTokenHash(tokenHash: string): ClientRecord | null {
    const row = this.db
      .prepare("SELECT client_id, name, token_hash, scopes, created_at, revoked_at FROM clients WHERE token_hash = ?")
      .get(tokenHash) as Record<string, string | null> | undefined;
    return row ? toClient(row) : null;
  }

  findClient(clientId: string): ClientRecord | null {
    const row = this.db
      .prepare("SELECT client_id, name, token_hash, scopes, created_at, revoked_at FROM clients WHERE client_id = ?")
      .get(clientId) as Record<string, string | null> | undefined;
    return row ? toClient(row) : null;
  }

  revokeClient(clientId: string, revokedAt: string): void {
    this.db.prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ?").run(revokedAt, clientId);
  }

  listClients(): ClientRecord[] {
    const rows = this.db
      .prepare("SELECT client_id, name, token_hash, scopes, created_at, revoked_at FROM clients ORDER BY created_at")
      .all() as Array<Record<string, string | null>>;
    return rows.map(toClient);
  }

  // ---- audit ----

  audit(kind: string, subject: string, detail: unknown, occurredAt: string): void {
    this.db
      .prepare("INSERT INTO audit_events (occurred_at, kind, subject, detail) VALUES (?, ?, ?, ?)")
      .run(occurredAt, kind, subject, JSON.stringify(detail ?? null));
  }

  auditCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    return row.c;
  }

  // ---- quota ledger（Core QuotaLedger 端口实现）----

  quotaTotal(dayKey: string): number {
    const row = this.db.prepare("SELECT tokens FROM quota_usage WHERE day_key = ?").get(dayKey) as
      | { tokens: number }
      | undefined;
    return row?.tokens ?? 0;
  }

  quotaRecord(dayKey: string, tokens: number): void {
    this.db
      .prepare(
        "INSERT INTO quota_usage (day_key, tokens) VALUES (?, ?) ON CONFLICT(day_key) DO UPDATE SET tokens = tokens + excluded.tokens",
      )
      .run(dayKey, tokens);
  }

  asBrokerTaskStore(): TaskBrokerStore {
    return {
      getTask: (id) => this.getBrokerTask(id),
      putTask: (task) => this.putBrokerTask(task),
      allTasks: () => this.allBrokerTasks(),
    };
  }

  asQuotaLedger(): QuotaLedger {
    return {
      totalForDay: (dayKey: string) => this.quotaTotal(dayKey),
      record: (dayKey: string, tokens: number) => this.quotaRecord(dayKey, tokens),
    };
  }

  // ---- broker_tasks（Core TaskBrokerStore 端口实现）----

  getBrokerTask(brokerRequestId: string): BrokerTaskRow | undefined {
    const row = this.db
      .prepare(
        "SELECT broker_request_id, client_request_id, prompt, workdir, status, session_id, created_at, updated_at FROM broker_tasks WHERE broker_request_id = ?",
      )
      .get(brokerRequestId) as Record<string, string> | undefined;
    return row ? toBrokerTask(row) : undefined;
  }

  putBrokerTask(task: BrokerTaskRow): void {
    this.db
      .prepare(
        "INSERT INTO broker_tasks (broker_request_id, client_request_id, prompt, workdir, status, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(broker_request_id) DO UPDATE SET status = excluded.status, session_id = excluded.session_id, updated_at = excluded.updated_at",
      )
      .run(task.brokerRequestId, task.clientRequestId, task.prompt, task.workdir, task.status, task.sessionId, task.createdAt, task.updatedAt);
  }

  allBrokerTasks(): BrokerTaskRow[] {
    return (
      this.db
        .prepare(
          "SELECT broker_request_id, client_request_id, prompt, workdir, status, session_id, created_at, updated_at FROM broker_tasks",
        )
        .all() as Array<Record<string, string>>
    ).map(toBrokerTask);
  }

  close(): void {
    this.db.close();
  }
}

function toClient(row: Record<string, string | null>): ClientRecord {
  return {
    clientId: row.client_id as string,
    name: row.name as string,
    tokenHash: row.token_hash as string,
    scopes: JSON.parse(row.scopes as string) as string[],
    createdAt: row.created_at as string,
    revokedAt: row.revoked_at ?? null,
  };
}

function toBrokerTask(row: Record<string, string>): BrokerTask {
  return {
    brokerRequestId: row.broker_request_id!,
    clientRequestId: row.client_request_id!,
    prompt: row.prompt!,
    workdir: row.workdir!,
    status: row.status as BrokerTask["status"],
    sessionId: row.session_id!,
    createdAt: row.created_at!,
    updatedAt: row.updated_at!,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
