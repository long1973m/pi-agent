/**
 * v0.10 A-3 — 表卡片存储
 *
 * 表卡片是表级语义载体（目的/边界/时机），补齐字段字典（列级）与指标定义（度量级）：
 * - 存储：.pi-data-agent/table-cards.json，复用 AtomicStore（临时写→校验→rename + revision 乐观锁）
 * - 数据模型：规范 §5.2（summary/suitableFor/boundaries/whenToUse/tags/status/fingerprint/stale/updatedAt）
 * - fingerprint：表 schema 指纹（列名+类型，sha256 前 16 位，与行数无关）；
 *   表重新加载且结构变化时由调用方标记 stale
 * - 骨架卡：无 LLM 时生成 summary 留空的待填卡片（status ai-drafted）
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AtomicStore, RevisionConflictError } from "../dashboard/services/atomic-store.js";
import type { RevisionedData } from "../dashboard/types.js";
import type { ColumnInfo } from "../types.js";
import { generateDatasetFingerprintSync } from "../utils/dataset-fingerprint.js";

export { RevisionConflictError };

/** 表卡片状态 */
export type TableCardStatus = "ai-drafted" | "user-confirmed";

/** 表卡片（规范 §5.2） */
export interface TableCard {
  /** 表名（主键） */
  tableName: string;
  /** 一句话：这是什么表 */
  summary: string;
  /** 适合什么（分析场景/问题类型） */
  suitableFor: string[];
  /** 边界：不含什么、时间范围、已知坑 */
  boundaries: string[];
  /** 什么时候需要找它（触发词/场景） */
  whenToUse: string[];
  /** 分类标签（导航分组用） */
  tags: string[];
  status: TableCardStatus;
  /** 表 schema 指纹（结构变化时标记 stale） */
  fingerprint: string;
  /** 结构与 fingerprint 不匹配（内容可能过期） */
  stale: boolean;
  updatedAt: string;
}

/** 用户编辑可更新字段 */
export interface TableCardUpdate {
  summary?: string;
  suitableFor?: string[];
  boundaries?: string[];
  whenToUse?: string[];
  tags?: string[];
  /** 传入 "user-confirmed" 即确认动作；确认时清除 stale */
  status?: TableCardStatus;
}

/** 字符串数组字段清洗：接受 string | string[]，过滤空值 */
function sanitizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

/** 生成表 schema 指纹（列名+类型；与行数无关，避免追加数据误报 stale） */
export function computeTableSchemaFingerprint(tableName: string, columns: ColumnInfo[]): string {
  return generateDatasetFingerprintSync([{ tableName, columns }]);
}

/** 生成骨架卡（无 LLM 兜底：summary 等留空待填） */
export function createSkeletonCard(tableName: string, fingerprint: string): TableCard {
  return {
    tableName,
    summary: "",
    suitableFor: [],
    boundaries: [],
    whenToUse: [],
    tags: [],
    status: "ai-drafted",
    fingerprint,
    stale: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 表卡片 Store
 *
 * 与 Dashboard 共用同一 table-cards.json（AtomicStore revision 乐观锁），编辑即时互通。
 */
export class TableCardStore {
  private atomicStore: AtomicStore<TableCard[]>;
  private auditLogPath: string;

  constructor(projectDir: string) {
    const filePath = join(projectDir, "table-cards.json");
    this.auditLogPath = join(projectDir, "audit.log");
    this.atomicStore = new AtomicStore<TableCard[]>(filePath, (entry) => this.writeAuditLog(entry));
  }

  /** 全部卡片 */
  list(): { cards: TableCard[]; revision: number } {
    const data = this.atomicStore.read();
    return { cards: data?.data ?? [], revision: data?.revision ?? 0 };
  }

  /** 按表名取卡片 */
  get(tableName: string): TableCard | null {
    const data = this.atomicStore.read();
    return data?.data.find((c) => c.tableName === tableName) ?? null;
  }

  /**
   * 用户编辑（PUT，带 expectedRevision 乐观锁）。
   *
   * - 卡片不存在时创建（首字段编辑即建卡）
   * - status 传 "user-confirmed" 即确认动作，同时清除 stale
   */
  put(
    tableName: string,
    update: TableCardUpdate,
    expectedRevision: number,
  ): RevisionedData<TableCard[]> {
    const data = this.atomicStore.read();
    const cards = data?.data ?? [];
    const existing = cards.find((c) => c.tableName === tableName);
    const now = new Date().toISOString();

    const confirmed = update.status === "user-confirmed";
    const next: TableCard = {
      tableName,
      summary: update.summary ?? existing?.summary ?? "",
      suitableFor: sanitizeStringArray(update.suitableFor) ?? existing?.suitableFor ?? [],
      boundaries: sanitizeStringArray(update.boundaries) ?? existing?.boundaries ?? [],
      whenToUse: sanitizeStringArray(update.whenToUse) ?? existing?.whenToUse ?? [],
      tags: sanitizeStringArray(update.tags) ?? existing?.tags ?? [],
      status: update.status ?? existing?.status ?? "ai-drafted",
      fingerprint: existing?.fingerprint ?? "",
      // 确认动作代表用户已基于当前结构复核 → 清除 stale
      stale: confirmed ? false : (existing?.stale ?? false),
      updatedAt: now,
    };

    const nextCards = existing
      ? cards.map((c) => (c.tableName === tableName ? next : c))
      : [...cards, next];

    return this.atomicStore.write(nextCards, expectedRevision, `table-card:${tableName}`);
  }

  /**
   * 保存 AI 起草结果（fire-and-forget 内部路径，跳过 revision 检查，整卡替换）
   */
  saveDraft(card: TableCard): RevisionedData<TableCard[]> {
    const data = this.atomicStore.read();
    const cards = data?.data ?? [];
    const existing = cards.some((c) => c.tableName === card.tableName);
    const nextCards = existing
      ? cards.map((c) => (c.tableName === card.tableName ? card : c))
      : [...cards, card];
    return this.atomicStore.write(nextCards, -1, `table-card:${card.tableName}:draft`);
  }

  /**
   * 结构变化标记：fingerprint 不匹配 → stale = true（不覆盖卡片内容）。
   * 匹配或无卡片时不做任何事。返回是否发生了标记。
   */
  markStaleIfChanged(tableName: string, currentFingerprint: string): boolean {
    const card = this.get(tableName);
    if (!card) return false;
    if (!currentFingerprint || card.fingerprint === currentFingerprint) return false;
    if (card.stale) return false; // 已标记过，幂等

    const data = this.atomicStore.read();
    const cards = data?.data ?? [];
    const nextCards = cards.map((c) =>
      c.tableName === tableName ? { ...c, stale: true, updatedAt: new Date().toISOString() } : c
    );
    this.atomicStore.write(nextCards, -1, `table-card:${tableName}:stale`);
    return true;
  }

  /**
   * 删除表卡片（表被 DROP 后清理孤儿卡片）。
   *
   * 与 markStaleIfChanged 同样跳过 revision 检查：删除由后端单方发起，
   * 前端不持有期望版本号。卡片不存在时返回 false（幂等）。
   */
  remove(tableName: string): boolean {
    const data = this.atomicStore.read();
    const cards = data?.data ?? [];
    const nextCards = cards.filter((c) => c.tableName !== tableName);
    if (nextCards.length === cards.length) return false;

    this.atomicStore.write(nextCards, -1, `table-card:${tableName}:remove`);
    return true;
  }

  private writeAuditLog(entry: { action: string; target: string; before?: string; after?: string }): void {
    try {
      mkdirSync(dirname(this.auditLogPath), { recursive: true });
      const logEntry = {
        id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        toolName: "dashboard",
        action: `table-card:${entry.action}`,
        actor: "user",
        durationMs: 0,
        result: "success" as const,
        summary: `${entry.action}: ${entry.target}`,
      };
      appendFileSync(this.auditLogPath, JSON.stringify(logEntry) + "\n", "utf-8");
    } catch {
      // 审计失败不影响主流程
    }
  }
}
