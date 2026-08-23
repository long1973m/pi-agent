/**
 * Dashboard — QueryMemory AtomicStore 适配器
 *
 * 职责：
 * 1. 封装 AtomicStore 管理 query-memory.json
 * 2. 兼容旧版 { entries, revision?, maxEntries? } 格式，自动迁移
 * 3. 为 sql-history.ts PATCH 路由提供原子写入 + 乐观锁能力
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AtomicStore, RevisionConflictError } from "./atomic-store.js";
import type { RevisionedData } from "../types.js";
import type { QueryMemory } from "../../types.js";

export { RevisionConflictError };

export class QueryMemoryStore {
  private atomicStore: AtomicStore<QueryMemory>;

  constructor(projectDir: string) {
    const filePath = join(projectDir, "query-memory.json");
    this.atomicStore = new AtomicStore<QueryMemory>(filePath);
    this.migrateIfLegacy(filePath);
  }

  /**
   * 读取数据（RevisionedData 包装）
   */
  read(): RevisionedData<QueryMemory> | null {
    return this.atomicStore.read();
  }

  /**
   * 原子写入
   *
   * @param memory - 查询记忆数据
   * @param expectedRevision - 期望版本号（-1 跳过检查）
   */
  write(memory: QueryMemory, expectedRevision: number): RevisionedData<QueryMemory> {
    return this.atomicStore.write(memory, expectedRevision, "query-memory");
  }

  /** 迁移旧版无 revision 包装的 query-memory.json */
  private migrateIfLegacy(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      // 如果已经是 RevisionedData 格式，跳过
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { revision?: unknown }).revision === "number" &&
        (parsed as { data?: unknown }).data &&
        typeof (parsed as { data?: unknown }).data === "object" &&
        Array.isArray(((parsed as { data?: { entries?: unknown } }).data as { entries?: unknown })?.entries)
      ) {
        return;
      }

      // 如果是旧版 QueryMemory 格式，包装为 RevisionedData
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { entries?: unknown }).entries)
      ) {
        console.log(
          "[QueryMemoryStore] Migrating legacy query-memory.json to RevisionedData format"
        );
        const legacy = parsed as { entries: unknown[]; maxEntries?: number; revision?: number };
        const wrapped: RevisionedData<QueryMemory> = {
          data: {
            maxEntries: legacy.maxEntries ?? 5,
            entries: legacy.entries as QueryMemory["entries"],
          },
          revision: legacy.revision ?? 1,
          updatedAt: new Date().toISOString(),
        };
        writeFileSync(filePath, JSON.stringify(wrapped, null, 2), "utf-8");
      }
    } catch {
      // 忽略
    }
  }
}
