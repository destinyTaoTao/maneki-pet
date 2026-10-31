import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MigrationError, RuntimeStore } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeStore SQLite 单一拥有者", () => {
  it("迁移建表：kv、客户端、审计、限额记账", () => {
    const store = new RuntimeStore(":memory:");
    store.kvSet("dnd", "1");
    expect(store.kvGet("dnd")).toBe("1");
    expect(store.kvGet("missing")).toBeNull();

    store.createClient({
      clientId: "c1",
      name: "shell",
      tokenHash: "hash-1",
      scopes: ["express"],
      createdAt: "2026-10-31T00:00:00Z",
    });
    const found = store.findClientByTokenHash("hash-1");
    expect(found?.clientId).toBe("c1");
    expect(found?.scopes).toEqual(["express"]);
    expect(found?.revokedAt).toBeNull();

    store.revokeClient("c1", "2026-10-31T01:00:00Z");
    const revoked = store.findClient("c1");
    expect(revoked?.revokedAt).toBe("2026-10-31T01:00:00Z");
    expect(store.listClients()).toHaveLength(1);

    store.audit("client.paired", "c1", { name: "shell" }, "2026-10-31T00:00:01Z");
    expect(store.auditCount()).toBe(1);

    store.quotaRecord("2026-10-31", 30);
    store.quotaRecord("2026-10-31", 12);
    expect(store.quotaTotal("2026-10-31")).toBe(42);
    store.close();
  });

  it("文件库跨重启保留数据（用量/客户端持久化）", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "runtime.db");
    const first = new RuntimeStore(dbPath);
    first.quotaRecord("2026-11-01", 777);
    first.createClient({
      clientId: "persisted",
      name: "shell",
      tokenHash: "hash-p",
      scopes: ["express", "notify"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    first.close();

    const second = new RuntimeStore(dbPath);
    expect(second.quotaTotal("2026-11-01")).toBe(777);
    expect(second.findClient("persisted")?.scopes).toEqual(["express", "notify"]);
    second.close();
  });

  it("升级迁移前先备份现有数据库", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "runtime.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (0, '2026-01-01T00:00:00Z')").run();
    seed.close();

    const store = new RuntimeStore(dbPath);
    store.kvSet("post-migration", "yes");
    store.close();
    expect(existsSync(`${dbPath}.bak-0`)).toBe(true);
  });

  it("新版本数据库拒绝被旧程序盲写", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "runtime.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, '2026-01-01T00:00:00Z')").run();
    seed.close();

    expect(() => new RuntimeStore(dbPath)).toThrow(MigrationError);
    expect(() => new RuntimeStore(dbPath)).toThrow(/newer than supported/);
  });

  it("提供 Core QuotaLedger 端口实现", () => {
    const store = new RuntimeStore(":memory:");
    const ledger = store.asQuotaLedger();
    ledger.record("2026-11-02", 100);
    expect(ledger.totalForDay("2026-11-02")).toBe(100);
    expect(ledger.totalForDay("2026-11-03")).toBe(0);
    store.close();
  });
});
