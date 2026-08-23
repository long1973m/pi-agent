/**
 * Pi Data Agent — Schema 指纹
 *
 * 用途：v0.2 过时闸预留接口，MVP 先实现但暂不使用
 *
 * 算法：
 * 1. 列名排序后拼接
 * 2. 每列：name + type + nullable
 * 3. 整体字符串做稳定 hash（SHA-256 前 16 位）
 *
 * 验收：
 * - 列变更后指纹不同
 */

import { createHash } from "node:crypto";
import type { ColumnInfo } from "../types.js";

/**
 * 生成 Schema 指纹
 *
 * @param columns 列定义数组
 * @returns 稳定指纹字符串
 */
export function generateSchemaFingerprint(columns: ColumnInfo[]): string {
  // 按列名排序（消除顺序差异）
  const sorted = [...columns].sort((a, b) => a.name.localeCompare(b.name));

  // 构造规范化字符串
  const normalized = sorted
    .map((c) => `${c.name}:${c.type}:${c.nullable ? "1" : "0"}`)
    .join("|");

  // 稳定 hash
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * 快速比较两个 schema 是否相同
 *
 * @param a 列定义数组 A
 * @param b 列定义数组 B
 * @returns 是否相同
 */
export function areSchemasEqual(a: ColumnInfo[], b: ColumnInfo[]): boolean {
  if (a.length !== b.length) return false;

  const fingerprintA = generateSchemaFingerprint(a);
  const fingerprintB = generateSchemaFingerprint(b);

  return fingerprintA === fingerprintB;
}
