/**
 * 物化记录持久化 — Dashboard「本地副本」视图的数据源
 *
 * 职责：
 * 1. 记录每次 materialize_remote_table 的结果（源表 → 本地表的对应关系与度量）
 * 2. 按 targetTable upsert：同一目标表只保留最新一条，视图呈现"当前本地副本"状态
 * 3. 保留物化时的远端行数（sourceRowCount）作为漂移基线，视图据此对比当前 COUNT
 * 4. 复用 AtomicStore：原子写 + 写入失败自动备份，写入失败不影响物化主流程
 *
 * 数据不含任何凭据；endpoint 已由调用方 redactCredentials 处理。
 */

import { AtomicStore } from "./dashboard/services/atomic-store.js";

/** 单条物化记录 */
export interface MaterializationRecord {
  /** 本地目标表名（唯一键，重复物化同一目标即 upsert） */
  targetTable: string;
  /** 远程连接别名 */
  alias: string;
  /** 远程源表名 */
  table: string;
  /** 物化后的行数 */
  rows: number;
  /** 列数 */
  columns: number;
  /** 物化时的远端总行数（漂移基线；row_limit 截断时仍有意义） */
  sourceRowCount: number;
  /** 行数上限（未设置为 undefined） */
  rowLimit?: number;
  /** 物化耗时毫秒 */
  durationMs: number;
  /** host:port/database（无凭据） */
  endpoint?: string;
  /** .duckdb 体积变化（字节） */
  dbSizeBefore?: number;
  dbSizeAfter?: number;
  /** 是否替换了已有同名表 */
  replaced: boolean;
  /** DECIMAL(p>38) 精度提示（落地 DOUBLE） */
  decimalWarnings: string[];
  /** 物化完成时间 ISO */
  materializedAt: string;
}

/**
 * 物化记录存储
 *
 * 写入方：materialize-remote 工具（成功返回摘要前）
 * 读取方：Dashboard GET /api/materializations
 */
export class MaterializationStore {
  private atomic: AtomicStore<MaterializationRecord[]>;

  constructor(filePath: string) {
    this.atomic = new AtomicStore<MaterializationRecord[]>(filePath);
  }

  /** 列出全部记录（新到旧） */
  list(): MaterializationRecord[] {
    const cur = this.atomic.read();
    const data = cur?.data ?? [];
    return [...data].sort((a, b) =>
      b.materializedAt.localeCompare(a.materializedAt)
    );
  }

  /**
   * upsert 一条记录（同一 targetTable 覆盖）
   *
   * 失败返回 false，不抛出——物化已成功，历史记录缺失不应让用户感觉失败。
   */
  record(entry: Omit<MaterializationRecord, "targetTable"> & { targetTable: string }): boolean {
    try {
      const cur = this.atomic.read();
      const data = (cur?.data ?? []).filter((r) => r.targetTable !== entry.targetTable);
      data.push(entry);
      this.atomic.write(data, cur?.revision ?? -1, entry.targetTable, describe(entry));
      return true;
    } catch {
      return false;
    }
  }
}

/** 写入审计前的摘要（不含凭据） */
function describe(r: Omit<MaterializationRecord, "targetTable"> & { targetTable: string }): string {
  return `${r.alias}.${r.table} → ${r.targetTable} (${r.rows} rows)`;
}
