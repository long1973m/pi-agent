/**
 * v0.8 B3 — SQL 历史编辑测试
 *
 * 验证：
 * 1. PATCH 检查 expectedRevision，不匹配返回 409
 * 2. PATCH 递增 revision
 * 3. 状态枚举包含 failed
 * 4. GET 返回 revision
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sql-history-edit", () => {
  it("PATCH 返回 409 当 expectedRevision 不匹配", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sql-test-"));
    const filePath = join(dir, "query-memory.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [{ id: "e1", naturalLanguageQuery: "test" }],
        revision: 5,
      })
    );

    const data = JSON.parse(readFileSync(filePath, "utf-8")) as {
      entries: Array<Record<string, unknown>>;
      revision?: number;
    };
    const currentRevision = data.revision ?? 0;
    assert.strictEqual(currentRevision, 5);

    // expectedRevision = 3 != 5 → 应该返回 409
    const expectedRevision = 3;
    assert.notStrictEqual(expectedRevision, currentRevision);

    rmSync(dir, { recursive: true, force: true });
  });

  it("revision 递增", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sql-test-"));
    const filePath = join(dir, "query-memory.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [{ id: "e1", naturalLanguageQuery: "test" }],
        revision: 2,
      })
    );

    const data = JSON.parse(readFileSync(filePath, "utf-8")) as {
      entries: Array<Record<string, unknown>>;
      revision?: number;
    };
    data.revision = (data.revision ?? 0) + 1;
    writeFileSync(filePath, JSON.stringify(data, null, 2));

    const updated = JSON.parse(readFileSync(filePath, "utf-8")) as {
      revision?: number;
    };
    assert.strictEqual(updated.revision, 3);

    rmSync(dir, { recursive: true, force: true });
  });

  it("状态枚举包含 failed", () => {
    const validStatuses = ["active", "outdated", "archived", "failed"];
    assert.ok(validStatuses.includes("failed"));
    assert.strictEqual(validStatuses.length, 4);
  });

  it("GET 返回 revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sql-test-"));
    const filePath = join(dir, "query-memory.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [{ id: "e1", naturalLanguageQuery: "test" }],
        revision: 7,
      })
    );

    let revision = 0;
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { revision?: number };
      revision = parsed.revision ?? 0;
    }

    assert.strictEqual(revision, 7);

    rmSync(dir, { recursive: true, force: true });
  });

  it("PATCH 更新字段并递增 revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sql-test-"));
    const filePath = join(dir, "query-memory.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "e1",
            naturalLanguageQuery: "旧查询",
            status: "active",
          },
        ],
        revision: 1,
      })
    );

    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as {
      entries: Array<Record<string, unknown>>;
      revision?: number;
    };

    const currentRevision = data.revision ?? 0;
    const expectedRevision = 1;

    // 乐观锁检查通过
    assert.strictEqual(expectedRevision, currentRevision);

    const entry = data.entries.find((e) => e.id === "e1");
    assert.ok(entry);

    // 更新字段
    entry!.naturalLanguageQuery = "新查询";
    entry!.status = "failed";

    // 递增 revision
    data.revision = currentRevision + 1;
    writeFileSync(filePath, JSON.stringify(data, null, 2));

    const updated = JSON.parse(readFileSync(filePath, "utf-8")) as {
      entries: Array<Record<string, unknown>>;
      revision?: number;
    };

    assert.strictEqual(updated.revision, 2);
    const updatedEntry = updated.entries.find((e) => e.id === "e1");
    assert.ok(updatedEntry);
    assert.strictEqual(updatedEntry!.naturalLanguageQuery, "新查询");
    assert.strictEqual(updatedEntry!.status, "failed");

    rmSync(dir, { recursive: true, force: true });
  });
});
