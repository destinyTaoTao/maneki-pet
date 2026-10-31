import { describe, expect, it } from "vitest";

import { validateScriptHashes, validateSkillPack, type SkillPackManifest } from "../src/index.js";

const valid: SkillPackManifest = {
  schemaVersion: 1,
  id: "bilibili-publish-prep",
  name: "B站发布备料",
  version: "1.0.0",
  experienceId: "9f34fd12-9172-44a6-8ebd-5913c872571e",
  entry: "SKILL.md",
  description: "从发布经验整理的备料流程说明。",
  scripts: [
    { path: "scripts/collect-stats.mjs", bytes: 512, sha256: "a".repeat(64) },
  ],
};

describe("validateSkillPack 技能包清单", () => {
  it("合法清单通过且 scripts 路径被规范化保留", () => {
    const result = validateSkillPack(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entry).toBe("SKILL.md");
      expect(result.value.scripts).toHaveLength(1);
    }
  });

  it("未知字段拒绝", () => {
    expect(validateSkillPack({ ...valid, extra: true }).ok).toBe(false);
  });

  it("id 必须是 kebab-case，version 必须是 semver", () => {
    expect(validateSkillPack({ ...valid, id: "Bad_Id" }).ok).toBe(false);
    expect(validateSkillPack({ ...valid, version: "1.0" }).ok).toBe(false);
  });

  it("entry 固定为 SKILL.md", () => {
    expect(validateSkillPack({ ...valid, entry: "OTHER.md" }).ok).toBe(false);
  });

  it("脚本路径：拒绝绝对路径、穿越与 scripts/ 之外", () => {
    expect(validateSkillPack({ ...valid, scripts: [{ path: "/etc/passwd", bytes: 1, sha256: "a".repeat(64) }] }).ok).toBe(false);
    expect(validateSkillPack({ ...valid, scripts: [{ path: "scripts/../secret.mjs", bytes: 1, sha256: "a".repeat(64) }] }).ok).toBe(false);
    expect(validateSkillPack({ ...valid, scripts: [{ path: "README.md", bytes: 1, sha256: "a".repeat(64) }] }).ok).toBe(false);
  });

  it("脚本哈希必须为 64 位十六进制；bytes 必须为正整数", () => {
    expect(validateSkillPack({ ...valid, scripts: [{ path: "scripts/a.mjs", bytes: 1, sha256: "xyz" }] }).ok).toBe(false);
    expect(validateSkillPack({ ...valid, scripts: [{ path: "scripts/a.mjs", bytes: 0, sha256: "a".repeat(64) }] }).ok).toBe(false);
  });

  it("重复脚本路径拒绝", () => {
    expect(
      validateSkillPack({
        ...valid,
        scripts: [
          { path: "scripts/a.mjs", bytes: 1, sha256: "a".repeat(64) },
          { path: "scripts/a.mjs", bytes: 2, sha256: "b".repeat(64) },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("validateScriptHashes 内容核对", () => {
  it("哈希与尺寸逐文件一致时通过", () => {
    const result = validateScriptHashes(valid, {
      "scripts/collect-stats.mjs": { bytes: 512, sha256: "a".repeat(64) },
      "SKILL.md": { bytes: 128, sha256: "b".repeat(64) },
    });
    expect(result.ok).toBe(true);
  });

  it("内容不符与未声明的额外脚本都拒绝", () => {
    expect(
      validateScriptHashes(valid, { "scripts/collect-stats.mjs": { bytes: 513, sha256: "a".repeat(64) } }).ok,
    ).toBe(false);
    const result = validateScriptHashes(valid, {
      "scripts/collect-stats.mjs": { bytes: 512, sha256: "a".repeat(64) },
      "scripts/extra.mjs": { bytes: 1, sha256: "c".repeat(64) },
    });
    expect(result.ok).toBe(false);
  });
});
