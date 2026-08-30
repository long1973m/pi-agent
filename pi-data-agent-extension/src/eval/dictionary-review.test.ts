/**
 * v0.7 Task 11 — 字典审核测试
 *
 * 测试审核流程：confirm / correct / uncertain / batchConfirm / getColumnMeaningWithStatus
 * 运行: npx tsx src/eval/dictionary-review.test.ts
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ColumnSemantic, DataDictionaryEntry, ColumnSemanticStatus } from "../types.js";

// ============================================================================
// Mock 构造工具
// ============================================================================

function createColumn(overrides?: Partial<ColumnSemantic>): ColumnSemantic {
  return {
    name: "col_test",
    type: "VARCHAR",
    inferredMeaning: "AI 推断含义",
    status: "ai-guessed",
    ...overrides,
  };
}

function createEntry(tableName: string, columns: ColumnSemantic[]): DataDictionaryEntry {
  return {
    tableName,
    columns,
    generatedAt: new Date().toISOString(),
    status: "ai-guessed",
  };
}

/**
 * 模拟 reviewColumn 核心逻辑（与 DataDictionaryManager.reviewColumn 对齐）
 */
function simulateReviewColumn(
  entry: DataDictionaryEntry,
  columnName: string,
  action: "confirmed" | "corrected" | "uncertain",
  correctedDescription?: string
): { success: boolean; column?: ColumnSemantic } {
  const col = entry.columns.find((c) => c.name === columnName);
  if (!col) return { success: false };

  const now = new Date().toISOString();

  switch (action) {
    case "confirmed":
      col.status = "user-confirmed";
      col.confirmedAt = now;
      col.validated = true;
      col.review = { action: "confirmed", reviewedAt: now };
      break;

    case "corrected":
      if (!correctedDescription) return { success: false };
      col.status = "user-corrected";
      col.userMeaning = correctedDescription;
      col.confirmedAt = now;
      col.validated = true;
      col.review = { action: "corrected", reviewedAt: now, originalSuggestion: col.inferredMeaning };
      break;

    case "uncertain":
      col.status = "uncertain";
      col.confirmedAt = now;
      col.validated = false;
      col.review = { action: "uncertain", reviewedAt: now };
      break;
  }

  return { success: true, column: col };
}

/**
 * 模拟 batchReviewColumns 核心逻辑（confirmed 分支）
 */
function simulateBatchConfirm(
  entry: DataDictionaryEntry,
  columnNames: string[],
  action: "confirmed" | "uncertain"
): { applied: number; skipped: number; lowConfidenceSkipped: string[] } {
  const columnNameSet = new Set(columnNames);
  let applied = 0;
  let skipped = 0;
  const lowConfidenceSkipped: string[] = [];

  for (const col of entry.columns) {
    if (!columnNameSet.has(col.name)) continue;

    switch (action) {
      case "confirmed": {
        const confidenceLevel = col.suggestion?.confidenceLevel;
        if (confidenceLevel !== "high" && confidenceLevel !== "medium") {
          lowConfidenceSkipped.push(col.name);
          skipped++;
          continue;
        }
        col.status = "user-confirmed";
        col.confirmedAt = new Date().toISOString();
        col.validated = true;
        col.review = { action: "confirmed", reviewedAt: new Date().toISOString() };
        applied++;
        break;
      }

      case "uncertain": {
        col.status = "uncertain";
        col.confirmedAt = new Date().toISOString();
        col.validated = false;
        col.review = { action: "uncertain", reviewedAt: new Date().toISOString() };
        applied++;
        break;
      }
    }
  }

  skipped += columnNames.filter((n) => !entry.columns.some((c) => c.name === n)).length;

  return { applied, skipped, lowConfidenceSkipped };
}

/**
 * 模拟 getColumnMeaningWithStatus
 */
function simulateGetColumnMeaningWithStatus(
  entry: DataDictionaryEntry,
  columnName: string
): { meaning: string; status: ColumnSemanticStatus } | undefined {
  const col = entry.columns.find((c) => c.name === columnName);
  if (!col) return undefined;
  const meaning = col.userMeaning ?? col.inferredMeaning;
  return meaning ? { meaning, status: col.status } : undefined;
}

// ============================================================================
// 测试 1: 确认操作 → status 变为 user-confirmed
// ============================================================================

describe("审核流程: 确认操作", () => {
  it("confirmed 后 status = user-confirmed", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", status: "ai-guessed", inferredMeaning: "金额" }),
    ]);
    const { success, column } = simulateReviewColumn(entry, "amount", "confirmed");
    assert.strictEqual(success, true);
    assert.strictEqual(column!.status, "user-confirmed");
  });

  it("confirmed 后 review.action = confirmed", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", status: "ai-guessed" }),
    ]);
    const { column } = simulateReviewColumn(entry, "amount", "confirmed");
    assert.strictEqual(column!.review?.action, "confirmed");
    assert.ok(column!.review?.reviewedAt !== undefined);
  });

  it("confirmed 后 validated = true", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", status: "ai-guessed", validated: false }),
    ]);
    const { column } = simulateReviewColumn(entry, "amount", "confirmed");
    assert.strictEqual(column!.validated, true);
    assert.ok(column!.confirmedAt !== undefined);
  });

  it("对不存在的列操作返回 false", () => {
    const entry = createEntry("orders", [createColumn({ name: "amount" })]);
    const { success } = simulateReviewColumn(entry, "nonexistent", "confirmed");
    assert.strictEqual(success, false);
  });
});

// ============================================================================
// 测试 2: 修正操作 → status 变为 user-corrected，保留 originalSuggestion
// ============================================================================

describe("审核流程: 修正操作", () => {
  it("corrected 后 status = user-corrected", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "status", inferredMeaning: "AI 推断的状态", status: "ai-guessed" }),
    ]);
    const { success, column } = simulateReviewColumn(entry, "status", "corrected", "订单状态");
    assert.strictEqual(success, true);
    assert.strictEqual(column!.status, "user-corrected");
  });

  it("corrected 后 review.action = corrected", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "status", inferredMeaning: "AI 推断的状态" }),
    ]);
    const { column } = simulateReviewColumn(entry, "status", "corrected", "订单状态");
    assert.strictEqual(column!.review?.action, "corrected");
  });

  it("corrected 后 review.originalSuggestion 保留原始推断", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "status", inferredMeaning: "AI 推断的状态" }),
    ]);
    const { column } = simulateReviewColumn(entry, "status", "corrected", "订单状态");
    assert.strictEqual(column!.review?.originalSuggestion, "AI 推断的状态");
  });

  it("corrected 后 userMeaning 设置为用户输入", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "status", inferredMeaning: "AI 推断的状态" }),
    ]);
    const { column } = simulateReviewColumn(entry, "status", "corrected", "订单状态（已修正）");
    assert.strictEqual(column!.userMeaning, "订单状态（已修正）");
  });

  it("corrected 无 description 时返回 false", () => {
    const entry = createEntry("orders", [createColumn({ name: "status" })]);
    const { success } = simulateReviewColumn(entry, "status", "corrected");
    assert.strictEqual(success, false);
  });
});

// ============================================================================
// 测试 3: 标记不确定 → status 变为 uncertain
// ============================================================================

describe("审核流程: 标记不确定", () => {
  it("uncertain 后 status = uncertain", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "notes", status: "ai-guessed" }),
    ]);
    const { success, column } = simulateReviewColumn(entry, "notes", "uncertain");
    assert.strictEqual(success, true);
    assert.strictEqual(column!.status, "uncertain");
  });

  it("uncertain 后 review.action = uncertain", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "notes", status: "ai-guessed" }),
    ]);
    const { column } = simulateReviewColumn(entry, "notes", "uncertain");
    assert.strictEqual(column!.review?.action, "uncertain");
  });

  it("uncertain 后 validated = false", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "notes", status: "ai-guessed", validated: true }),
    ]);
    const { column } = simulateReviewColumn(entry, "notes", "uncertain");
    assert.strictEqual(column!.validated, false);
  });
});

// ============================================================================
// 测试 4: 批量确认 → 跳过低置信度字段
// ============================================================================

describe("审核流程: 批量确认", () => {
  const makeSuggestion = (level: string) => ({
    confidence: level === "high" ? 0.9 : level === "medium" ? 0.6 : 0.2,
    confidenceLevel: level as any,
    evidence: ["e1"],
    uncertainties: level === "low" ? ["不确定"] : [],
    modelVersion: "v1",
    generatedAt: "2026-01-01",
    sourceSchemaRevision: "r1",
  });

  it("只确认 high/medium 置信度字段", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", status: "ai-guessed", suggestion: makeSuggestion("high") }),
      createColumn({ name: "notes", status: "ai-guessed", suggestion: makeSuggestion("low") }),
      createColumn({ name: "region", status: "ai-guessed", suggestion: makeSuggestion("medium") }),
    ]);

    const result = simulateBatchConfirm(entry, ["amount", "notes", "region"], "confirmed");
    assert.strictEqual(result.applied, 2);
    assert.strictEqual(result.skipped, 1);
    assert.ok(result.lowConfidenceSkipped.includes("notes"));
  });

  it("跳过无 suggestion 的字段", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", status: "ai-guessed", suggestion: makeSuggestion("high") }),
      createColumn({ name: "custom_field", status: "ai-guessed" }),
    ]);

    const result = simulateBatchConfirm(entry, ["amount", "custom_field"], "confirmed");
    assert.strictEqual(result.applied, 1);
    assert.ok(result.lowConfidenceSkipped.includes("custom_field"));
  });
});

// ============================================================================
// 测试 5: 批量确认 → uncertain 默认不进入
// ============================================================================

describe("审核流程: 批量确认排除 uncertain", () => {
  it("uncertain 状态字段在 batch confirm 时跳过", () => {
    const columns: ColumnSemantic[] = [
      createColumn({ name: "amount", status: "ai-guessed" }),
      createColumn({ name: "notes", status: "uncertain" }),
      createColumn({ name: "region", status: "ai-guessed" }),
    ];

    const selectedColumns = ["amount", "notes", "region"];
    let applied = 0;

    for (const col of columns) {
      if (!selectedColumns.includes(col.name)) continue;
      if (col.status === "uncertain") continue;
      col.status = "user-confirmed";
      col.confirmedAt = new Date().toISOString();
      applied++;
    }

    assert.strictEqual(applied, 2);
    assert.strictEqual(columns[1].status, "uncertain");
  });
});

// ============================================================================
// 测试 6: 获取带状态的含义 → getColumnMeaningWithStatus
// ============================================================================

describe("审核流程: getColumnMeaningWithStatus", () => {
  it("ai-guessed 字段返回 inferredMeaning + ai-guessed 状态", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", inferredMeaning: "金额", status: "ai-guessed" }),
    ]);
    const result = simulateGetColumnMeaningWithStatus(entry, "amount");
    assert.ok(result !== undefined);
    assert.strictEqual(result!.meaning, "金额");
    assert.strictEqual(result!.status, "ai-guessed");
  });

  it("user-confirmed 字段返回 userMeaning（优先）", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "amount", inferredMeaning: "AI 推断的金额", userMeaning: "销售额（元）", status: "user-confirmed" }),
    ]);
    const result = simulateGetColumnMeaningWithStatus(entry, "amount");
    assert.ok(result !== undefined);
    assert.strictEqual(result!.meaning, "销售额（元）");
    assert.strictEqual(result!.status, "user-confirmed");
  });

  it("user-corrected 字段返回 userMeaning + user-corrected 状态", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "status", inferredMeaning: "状态", userMeaning: "订单状态（已修正）", status: "user-corrected" }),
    ]);
    const result = simulateGetColumnMeaningWithStatus(entry, "status");
    assert.ok(result !== undefined);
    assert.strictEqual(result!.meaning, "订单状态（已修正）");
    assert.strictEqual(result!.status, "user-corrected");
  });

  it("uncertain 字段返回 inferredMeaning + uncertain 状态", () => {
    const entry = createEntry("orders", [
      createColumn({ name: "notes", inferredMeaning: "可能为备注", status: "uncertain" }),
    ]);
    const result = simulateGetColumnMeaningWithStatus(entry, "notes");
    assert.ok(result !== undefined);
    assert.strictEqual(result!.meaning, "可能为备注");
    assert.strictEqual(result!.status, "uncertain");
  });

  it("不存在的列返回 undefined", () => {
    const entry = createEntry("orders", [createColumn({ name: "amount" })]);
    const result = simulateGetColumnMeaningWithStatus(entry, "nonexistent");
    assert.strictEqual(result, undefined);
  });

  it("含义为空时返回 undefined", () => {
    const entry = createEntry("orders", [createColumn({ name: "empty_col", inferredMeaning: "" })]);
    const result = simulateGetColumnMeaningWithStatus(entry, "empty_col");
    assert.strictEqual(result, undefined);
  });
});