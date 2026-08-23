/**
 * Pi Data Agent — 数据集指纹
 *
 * 用途：查询记忆相关性闸 — 判断某条查询记忆是否涉及当前数据集
 *
 * 算法：
 * 1. 表名排序后拼接（消除顺序差异）
 * 2. 每张表的 schema 用 schema-fingerprint 生成
 * 3. 整体字符串做稳定 hash（djb2）
 *
 * 验收：
 * - 相同表结构 → 相同指纹
 * - 表结构变更 → 指纹不同
 */

import { createHash } from "node:crypto";
import type { ColumnInfo } from "../types.js";

/** 单表 schema 描述（用于指纹计算） */
interface TableSchemaDesc {
  tableName: string;
  columns: ColumnInfo[];
}

/**
 * 生成数据集指纹
 *
 * @param tableNames 当前数据集的所有表名
 * @param getSchema 获取表 schema 的回调（返回 ColumnInfo[]）
 * @returns 稳定指纹字符串
 */
export async function generateDatasetFingerprint(
  tableNames: string[],
  getSchema: (tableName: string) => Promise<ColumnInfo[]>
): Promise<string> {
  // 1. 表名排序（消除顺序差异）
  const sortedNames = [...tableNames].sort();

  // 2. 收集每张表的 schema
  const tableSchemas: TableSchemaDesc[] = [];
  for (const name of sortedNames) {
    const columns = await getSchema(name);
    tableSchemas.push({ tableName: name, columns });
  }

  // 3. 构造规范化字符串
  const normalized = tableSchemas
    .map((t) => {
      const colStr = t.columns
        .map((c) => `${c.name}:${c.type}`)
        .join(",");
      return `${t.tableName}[${colStr}]`;
    })
    .join("|");

  // 4. 稳定 hash（SHA-256 前 16 位）
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * 同步版本：已知 schema 时直接生成
 *
 * @param tableSchemas 表名 + 列信息的数组
 * @returns 稳定指纹字符串
 */
export function generateDatasetFingerprintSync(
  tableSchemas: TableSchemaDesc[]
): string {
  // 按表名排序
  const sorted = [...tableSchemas].sort((a, b) =>
    a.tableName.localeCompare(b.tableName)
  );

  const normalized = sorted
    .map((t) => {
      const colStr = t.columns
        .map((c) => `${c.name}:${c.type}`)
        .join(",");
      return `${t.tableName}[${colStr}]`;
    })
    .join("|");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export type { TableSchemaDesc };
