import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureOpsData } from "../src/platform-commands.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const fixtures: string[] = [];
const shim = { python: "synthetic-python", config: "synthetic-config", access: "synthetic-access" };
const ops = {
  schemaVersion: 1, platform: "bilibili", videoId: "BV-SYNTHETIC", date: "2026-11-15",
  plays: 7654321, likes: 321, comments: 12, coins: 1, shares: 2, source: "manual-export",
};

function opsFile(value: unknown): string {
  const fixture = mkdtempSync(join(tmpdir(), "maneki-cli-ops-"));
  fixtures.push(fixture);
  const file = join(fixture, "ops.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const fixture of fixtures.splice(0)) {
    const actual = realpathSync(fixture);
    if (dirname(actual) !== realpathSync(tmpdir()) || !/^maneki-cli-ops-/.test(basename(actual)))
      throw new Error("refusing to clean an unexpected fixture directory");
    rmSync(actual, { recursive: true, force: true });
  }
});

it("运营数据回执携带完整已校验指标附件，不仅保存导出文件路径", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: '{"message_id":"synthetic-message"}', stderr: "", pid: 0, output: [] });

  expect(captureOpsData(shim, { opsFile: opsFile(ops), inputId: "synthetic-input" })).toEqual({ videoId: ops.videoId, date: ops.date, messageId: "synthetic-message" });

  const options = vi.mocked(spawnSync).mock.calls[0]?.[2];
  const envelope = JSON.parse(String(options?.input));
  expect(envelope.event.text).toContain("source=manual-export");
  expect(envelope.attachments).toEqual([{
    attachment_id: "ops-data", label: "ops-data.json", mime_type: "application/json", bytes: JSON.stringify(ops),
  }]);
  expect(Buffer.byteLength(envelope.attachments[0].bytes, "utf8")).toBeLessThanOrEqual(1024 * 1024);
});

it("无效或非人工运营数据在调用 shim 前拒绝", () => {
  for (const value of [{ ...ops, plays: -1 }, { ...ops, source: "scraped" }]) {
    expect(() => captureOpsData(shim, { opsFile: opsFile(value), inputId: "synthetic-input" })).toThrow("ops data failed contract validation");
  }
  expect(spawnSync).not.toHaveBeenCalled();
});
