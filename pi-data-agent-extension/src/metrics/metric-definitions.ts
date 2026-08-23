/**
 * v0.10 A-4/A-6 — 指标定义读取（Agent 侧）
 *
 * MetricStore 在 dashboard/services 下（Dashboard CRUD 用），Agent 侧只需要只读访问：
 * - get_table_card 装配【相关指标口径】节（metrics.datasets 包含该表 → 关联键）
 * - before_agent_start L0 导航层全量注入指标 name+definition
 *
 * 本模块零写入、零自有存储，与 Dashboard 同一 metrics.json 数据源。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricEntry } from "../dashboard/types.js";

/** 判断是否为旧口径迁移来的历史条目（只读归档，不参与常规 CRUD 与 L0 注入） */
export function isLegacyMetric(metric: MetricEntry): boolean {
  return metric.legacyCaliber === true || typeof metric.question === "string";
}

/**
 * 读取 metrics.json 原始内容（含 archived 与 legacy 条目）。
 * 兼容两种格式：AtomicStore 的 RevisionedData 包装 / 迁移前的裸数组。
 */
export function readMetricsRaw(projectDir: string): { metrics: MetricEntry[]; revision: number } {
  const filePath = join(projectDir, "metrics.json");
  if (!existsSync(filePath)) return { metrics: [], revision: 0 };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { data?: unknown }).data)
    ) {
      const wrapped = parsed as { data: MetricEntry[]; revision?: number };
      return { metrics: wrapped.data, revision: wrapped.revision ?? 0 };
    }
    if (Array.isArray(parsed)) {
      return { metrics: parsed as MetricEntry[], revision: 0 };
    }
    return { metrics: [], revision: 0 };
  } catch (err) {
    console.warn("[metric-definitions] Failed to read metrics.json:", err);
    return { metrics: [], revision: 0 };
  }
}

/**
 * 可注入/可管理的活跃指标定义：排除 archived 与 legacy（历史口径走 caliberContext 通道）。
 */
export function listActiveMetricDefinitions(projectDir: string): MetricEntry[] {
  return readMetricsRaw(projectDir).metrics.filter((m) => !m.archived && !isLegacyMetric(m));
}
