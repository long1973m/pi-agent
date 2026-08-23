/**
 * Dashboard — 查询记忆 Reader
 *
 * 复用现有 query-memory.json，只读访问：
 * 1. 读取全部 entries
 * 2. 判定状态（active / outdated / failed）
 *    - outdated: entry.datasetFingerprint 与当前 DuckDB schema fingerprint 不匹配
 *    - active: 成功且 fingerprint 匹配
 *    - failed: success === false
 * 3. 分页 + 排序 + 筛选
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { QueryMemoryEntry } from "../../types.js";
import type { DuckDBEngine } from "../../engine/duckdb.js";
import { generateDatasetFingerprint } from "../../utils/dataset-fingerprint.js";
import type { SqlHistoryEntry, PaginatedResponse } from "../types.js";

/**
 * 查询记忆 Reader（只读）
 */
export class QueryMemoryReader {
  private queryMemoryPath: string;
  private currentFingerprint: Promise<string | null>;

  constructor(projectDir: string, engine: DuckDBEngine | null = null) {
    this.queryMemoryPath = join(projectDir, "query-memory.json");
    // 构造时立即开始计算 fingerprint（不阻塞构造函数）
    this.currentFingerprint = this.computeCurrentFingerprint(engine);
  }

  /**
   * 获取 SQL 历史列表（async 因为 fingerprint 计算是异步的）
   */
  async list(params: {
    page?: number;
    size?: number;
    status?: string;
    sort?: "recent" | "useCount";
    query?: string;
  }): Promise<PaginatedResponse<SqlHistoryEntry>> {
    const entries = this.readEntries();

    // 等待当前数据集 fingerprint
    const currentFingerprint = await this.currentFingerprint;

    // 转换为 SQL 历史条目（判定状态）
    let items: SqlHistoryEntry[] = entries.map((e) => {
      let status: "active" | "outdated" | "failed";

      if (!e.success) {
        status = "failed";
      } else if (
        currentFingerprint !== null &&
        e.datasetFingerprint &&
        e.datasetFingerprint !== currentFingerprint
      ) {
        status = "outdated";
      } else {
        status = "active";
      }

      return {
        id: e.id,
        naturalLanguageQuery: e.naturalLanguageQuery,
        sql: e.sql,
        timestamp: e.timestamp,
        useCount: e.useCount,
        success: e.success,
        resultSummary: e.resultSummary,
        notes: e.notes,
        pinned: e.pinned,
        status,
      };
    });

    // 筛选
    const statusFilter = params.status?.toLowerCase();
    if (statusFilter) {
      items = items.filter((item) => item.status === statusFilter);
    }

    const query = (params.query ?? "").toLowerCase().trim();
    if (query) {
      items = items.filter(
        (item) =>
          item.naturalLanguageQuery.toLowerCase().includes(query) ||
          item.sql.toLowerCase().includes(query)
      );
    }

    // 排序
    const sort = params.sort ?? "recent";
    if (sort === "useCount") {
      items.sort((a, b) => b.useCount - a.useCount);
    } else {
      items.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    }

    // 分页
    const page = Math.max(1, params.page ?? 1);
    const size = Math.min(100, Math.max(1, params.size ?? 20));
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const start = (page - 1) * size;
    const pagedItems = items.slice(start, start + size);

    return { items: pagedItems, total, page, size, totalPages };
  }

  // =========================================================================
  // Private
  // =========================================================================

  /** 异步计算当前数据集 fingerprint */
  private async computeCurrentFingerprint(engine: DuckDBEngine | null): Promise<string | null> {
    if (!engine) return null;

    try {
      const tables = await engine.getTables();
      if (tables.length === 0) return null;

      return await generateDatasetFingerprint(tables, (name) => engine.getSchema(name));
    } catch (err) {
      console.warn("[QueryMemoryReader] Failed to compute dataset fingerprint:", err);
      return null;
    }
  }

  private readEntries(): QueryMemoryEntry[] {
    if (!existsSync(this.queryMemoryPath)) return [];
    try {
      const raw = readFileSync(this.queryMemoryPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      // 兼容 RevisionedData 格式（AtomicStore 迁移后）：{ data: { entries }, revision, updatedAt }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { data?: unknown }).data &&
        typeof (parsed as { data?: unknown }).data === "object" &&
        Array.isArray(((parsed as { data?: { entries?: unknown } }).data as { entries?: unknown })?.entries)
      ) {
        return ((parsed as { data?: { entries?: QueryMemoryEntry[] } }).data as { entries: QueryMemoryEntry[] }).entries;
      }

      // 旧版格式：{ entries, revision?, maxEntries? }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { entries?: unknown }).entries)
      ) {
        return (parsed as { entries: QueryMemoryEntry[] }).entries;
      }

      return [];
    } catch {
      return [];
    }
  }
}
