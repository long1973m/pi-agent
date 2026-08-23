/**
 * Dashboard — 字典 Store
 *
 * 复用现有 PersistenceManager 的路径管理，在 AtomicStore 之上实现：
 * 1. 读取 data-dictionary.json（兼容旧版无 revision 格式）
 * 2. 单字段编辑（PATCH /api/dictionaries/:table/:column）
 * 3. 批量确认（PATCH /api/dictionaries/:table）
 * 4. 状态自动推导
 * 5. 新增 notes 字段
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import type { DataDictionaryEntry, ColumnSemantic, ColumnSemanticStatus } from "../../types.js";
import type { DuckDBEngine } from "../../engine/duckdb.js";
import type { RevisionedData } from "../types.js";
import { AtomicStore, RevisionConflictError } from "./atomic-store.js";

/** 带扩展的字典（支持 notes） */
export interface ExtendedColumnSemantic extends ColumnSemantic {
  /** 用户备注（v0.6 新增） */
  notes?: string;
}

export interface ExtendedDataDictionaryEntry extends Omit<DataDictionaryEntry, "columns"> {
  columns: ExtendedColumnSemantic[];
}

/**
 * 字典 Store
 */
export class DictionaryStore {
  private atomicStore: AtomicStore<ExtendedDataDictionaryEntry[]>;
  private auditLogPath: string;
  private engine: DuckDBEngine | null;

  constructor(projectDir: string, engine: DuckDBEngine | null = null) {
    const dictPath = join(projectDir, "data-dictionary.json");
    // audit.log 路径：projectDir 已是 .pi-data-agent/ 目录
    this.auditLogPath = join(projectDir, "audit.log");
    this.engine = engine;

    // 审计日志写入器
    const auditWriter = (entry: {
      action: string;
      target: string;
      field?: string;
      before?: string;
      after?: string;
    }) => {
      this.writeAuditLog(entry);
    };

    this.atomicStore = new AtomicStore<ExtendedDataDictionaryEntry[]>(dictPath, auditWriter);

    // 如果旧版文件没有 revision 包装，迁移
    this.migrateIfLegacy(dictPath);
  }

  /**
   * 获取所有字典数据
   */
  read(): RevisionedData<ExtendedDataDictionaryEntry[]> | null {
    return this.atomicStore.read();
  }

  /**
   * 获取表列表（含字段数、已确认数、不确定数、orphaned 数）
   *
   * orphaned 定义：字典中记录的字段在 DuckDB 当前 schema 中已不存在。
   * 当 engine 不可用时，orphanedCount 返回 -1（表示无法检测）。
   */
  getTableList(): Promise<{
    tables: Array<{
      name: string;
      columnCount: number;
      confirmedCount: number;
      uncertainCount: number;
      /** 在 DuckDB 中已不存在的字段数（-1 = 不可检测） */
      orphanedCount: number;
    }>;
    revision: number;
  }> {
    return this.getTableListWithOrphanDetection();
  }

  private async getTableListWithOrphanDetection() {
    const data = this.atomicStore.read();
    const revision = data?.revision ?? 0;
    const entries = data?.data ?? [];

    // 如果有 engine，预取所有表的 schema（批量）
    let liveColumns: Map<string, Set<string>> | null = null;
    if (this.engine) {
      try {
        const tables = await this.engine.getTables();
        liveColumns = new Map();
        for (const tableName of tables) {
          const schema = await this.engine.getSchema(tableName);
          liveColumns.set(tableName, new Set(schema.map((c) => c.name)));
        }
      } catch {
        liveColumns = null;
      }
    }

    const tables = entries.map((entry) => {
      const confirmed = entry.columns.filter(
        (c) => c.status === "user-confirmed" || c.status === "user-corrected"
      ).length;
      const uncertain = entry.columns.filter(
        (c) => c.status === "uncertain" || c.status === "ai-guessed"
      ).length;

      // orphaned 检测：字典字段在 DuckDB schema 中找不到
      let orphanedCount = -1;
      if (liveColumns) {
        const live = liveColumns.get(entry.tableName);
        if (live) {
          orphanedCount = entry.columns.filter((c) => !live.has(c.name)).length;
        } else {
          // 整张表在 DuckDB 中都不存在，所有字段都是 orphaned
          orphanedCount = entry.columns.length;
        }
      }

      return {
        name: entry.tableName,
        columnCount: entry.columns.length,
        confirmedCount: confirmed,
        uncertainCount: uncertain,
        orphanedCount,
      };
    });

    return { tables, revision };
  }

  /**
   * 获取单张表的字段列表
   */
  getTable(tableName: string): {
    entry: ExtendedDataDictionaryEntry | null;
    revision: number;
  } {
    const data = this.atomicStore.read();
    const revision = data?.revision ?? 0;
    const entry = data?.data?.find((e) => e.tableName === tableName) ?? null;
    return { entry, revision };
  }

  /**
   * 单字段编辑
   */
  updateColumn(
    tableName: string,
    columnName: string,
    updates: {
      description?: string;
      userMeaning?: string;
      notes?: string;
      status?: ColumnSemanticStatus;
    },
    expectedRevision: number,
  ): RevisionedData<ExtendedDataDictionaryEntry[]> {
    const data = this.atomicStore.read();
    if (!data) throw new RevisionConflictError("字典数据不存在");

    const entries = data.data.map((entry) => {
      if (entry.tableName !== tableName) return entry;

      return {
        ...entry,
        columns: entry.columns.map((col) => {
          if (col.name !== columnName) return col;

          const before = JSON.stringify(col);
          const updated = { ...col };

          // 更新字段
          if (updates.userMeaning !== undefined) {
            updated.userMeaning = updates.userMeaning;
          }
          if (updates.description !== undefined) {
            updated.inferredMeaning = updates.description;
          }
          if (updates.notes !== undefined) {
            updated.notes = updates.notes;
          }

          // 状态推导
          if (updates.status) {
            updated.status = updates.status;
          } else if (updates.userMeaning !== undefined && updates.userMeaning !== col.userMeaning) {
            updated.status = "user-corrected";
            updated.confirmedAt = new Date().toISOString();
          }

          // 记录审计
          this.writeAuditLog({
            action: "update-column",
            target: `${tableName}.${columnName}`,
            before: before.slice(0, 200),
            after: JSON.stringify(updated).slice(0, 200),
          });

          return updated;
        }),
      };
    });

    return this.atomicStore.write(entries, expectedRevision, `dictionary:${tableName}`);
  }

  /**
   * 批量确认
   */
  batchConfirm(
    tableName: string,
    columns: string[],
    expectedRevision: number,
  ): RevisionedData<ExtendedDataDictionaryEntry[]> {
    const data = this.atomicStore.read();
    if (!data) throw new RevisionConflictError("字典数据不存在");

    const entries = data.data.map((entry) => {
      if (entry.tableName !== tableName) return entry;

      return {
        ...entry,
        columns: entry.columns.map((col) => {
          if (!columns.includes(col.name)) return col;
          // 不默认处理 uncertain
          if (col.status === "uncertain") return col;

          const updated = {
            ...col,
            status: "user-confirmed" as ColumnSemanticStatus,
            confirmedAt: new Date().toISOString(),
          };

          this.writeAuditLog({
            action: "confirm-column",
            target: `${tableName}.${col.name}`,
            before: col.status,
            after: "user-confirmed",
          });

          return updated;
        }),
      };
    });

    return this.atomicStore.write(entries, expectedRevision, `dictionary:${tableName}`);
  }

  /**
   * 导出 Markdown
   */
  exportMarkdown(tableName: string): string | null {
    const { entry } = this.getTable(tableName);
    if (!entry) return null;

    const lines = [
      `# ${tableName}`,
      "",
      `> Generated at ${new Date().toLocaleString("zh-CN")}`,
      "",
      "| 字段名 | 类型 | 状态 | 业务含义 | 备注 |",
      "|--------|------|------|----------|------|",
    ];

    for (const col of entry.columns) {
      const meaning = col.userMeaning || col.inferredMeaning;
      const notes = (col as ExtendedColumnSemantic).notes || "";
      lines.push(
        `| ${col.name} | ${col.type} | ${col.status} | ${meaning || "-"} | ${notes || "-"} |`
      );
    }

    return lines.join("\n");
  }

  /**
   * 直接写入 entries（供推断/审核路由使用，保持 AtomicStore revision 一致性）
   */
  write(
    entries: ExtendedDataDictionaryEntry[],
    expectedRevision: number,
    auditTarget: string,
  ): RevisionedData<ExtendedDataDictionaryEntry[]> {
    return this.atomicStore.write(entries, expectedRevision, auditTarget);
  }

  // =========================================================================
  // Private
  // =========================================================================

  /** 迁移旧版无 revision 包装的 data-dictionary.json */
  private migrateIfLegacy(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      // 如果已经是 RevisionedData 格式，跳过
      if (parsed && typeof parsed.revision === "number" && Array.isArray(parsed.data)) {
        return;
      }

      // 如果是旧版 DataDictionaryEntry[] 格式，包装为 RevisionedData
      if (Array.isArray(parsed)) {
        console.log("[DictionaryStore] Migrating legacy data-dictionary.json to RevisionedData format");
        const wrapped: RevisionedData<ExtendedDataDictionaryEntry[]> = {
          data: parsed as ExtendedDataDictionaryEntry[],
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        writeFileSync(filePath, JSON.stringify(wrapped, null, 2), "utf-8");
      }
    } catch {
      // 忽略
    }
  }

  private writeAuditLog(entry: {
    action: string;
    target: string;
    before?: string;
    after?: string;
  }): void {
    try {
      mkdirSync(join(this.auditLogPath, ".."), { recursive: true });
      const logEntry = {
        id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        toolName: "dashboard",
        action: `dictionary:${entry.action}`,
        actor: "user",
        durationMs: 0,
        result: "success" as const,
        summary: `${entry.action}: ${entry.target}`,
        target: entry.target,
        before: entry.before,
        after: entry.after,
      };
      appendFileSync(
        this.auditLogPath,
        JSON.stringify(logEntry) + "\n",
        "utf-8"
      );
    } catch {
      // 审计日志写入失败不影响主流程
    }
  }
}
