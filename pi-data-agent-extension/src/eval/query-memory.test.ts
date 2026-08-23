import { describe, it, expect } from "vitest";
import { QueryMemoryManager } from "../hooks/query-memory.js";
import type { PersistenceManager } from "../persistence.js";

describe("QueryMemoryManager", () => {
  // 模拟 PersistenceManager
  const mockPersistence = {
    loadQueryMemory: () => ({ entries: [], maxEntries: 5 }),
    saveQueryMemory: () => {},
  } as unknown as PersistenceManager;

  it("相同SQL只更新次数不新增条目", () => {
    const manager = new QueryMemoryManager(mockPersistence);
    const sql = "SELECT * FROM users";

    manager.recordQuery({
      naturalLanguageQuery: "查所有用户",
      sql,
      datasetFingerprint: "fp1",
      resultSummary: "10 rows",
    });

    manager.recordQuery({
      naturalLanguageQuery: "查所有用户",
      sql,
      datasetFingerprint: "fp1",
      resultSummary: "9 rows",
    });

    const memory = manager.getMemory();
    expect(memory.entries.length).toBe(1);
    expect(memory.entries[0].useCount).toBe(2);
    expect(memory.entries[0].resultSummary).toBe("9 rows"); // 取最新的值
  });

  it("格式不同的相同SQL做去重", () => {
    const manager = new QueryMemoryManager(mockPersistence);

    manager.recordQuery({
      naturalLanguageQuery: "查用户",
      sql: "SELECT * FROM users",
      datasetFingerprint: "fp1",
    });

    manager.recordQuery({
      naturalLanguageQuery: "查用户",
      sql: "SELECT  *  FROM   users",
      datasetFingerprint: "fp1",
    });

    manager.recordQuery({
      naturalLanguageQuery: "查用户",
      sql: "select * from users",
      datasetFingerprint: "fp1",
    });

    manager.recordQuery({
      naturalLanguageQuery: "带过滤条件",
      sql: "SELECT * FROM users WHERE 1=1",
      datasetFingerprint: "fp1",
    });

    const memory = manager.getMemory();
    expect(memory.entries.length).toBe(2);
    expect(memory.entries[0].useCount).toBe(3); // 前三个是同一个SQL
    expect(memory.entries[1].useCount).toBe(1);
  });
});
