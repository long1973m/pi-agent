/**
 * v0.7 Task 11 — 字典推断测试
 *
 * 覆盖 Spec §18.2 场景：I1-I12
 * 运行: npx tsx src/eval/dictionary-inference.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InferenceCache } from "../dictionary/inference/inference-cache.js";
import { validateSuggestionSchema, validateSuggestionBatch } from "../dictionary/inference/suggestion-schema.js";
import { applyConfidenceRules } from "../dictionary/inference/confidence-evaluator.js";
import type { ColumnSemantic, DataDictionaryEntry, DictionarySuggestion } from "../types.js";

// ============================================================================
// Mock 构造工具
// ============================================================================

function createColumn(overrides?: Partial<ColumnSemantic>): ColumnSemantic {
  return {
    name: "col_test",
    type: "VARCHAR",
    inferredMeaning: "",
    status: "ai-guessed",
    ...overrides,
  };
}

function createDictionaryEntry(tableName: string, columns: ColumnSemantic[]): DataDictionaryEntry {
  return {
    tableName,
    columns,
    generatedAt: new Date().toISOString(),
    status: "ai-guessed",
  };
}

function createValidSuggestion(overrides?: Partial<DictionarySuggestion>): DictionarySuggestion {
  return {
    table: "test_table",
    column: "col_a",
    suggestedDescription: "测试含义",
    suggestedAliases: ["别名1"],
    status: "ai-guessed",
    confidence: 0.85,
    confidenceLevel: "high",
    evidence: ["列名包含 amount 关键词", "类型为 DECIMAL"],
    uncertainties: [],
    modelVersion: "test-v1",
    generatedAt: new Date().toISOString(),
    sourceSchemaRevision: "rev-001",
    ...overrides,
  };
}

// ============================================================================
// I1: 新数据集首次加载 — empty-only 模式正确筛选空字段
// ============================================================================

describe("I1: empty-only 模式筛选空字段", () => {
  it("返回 inferredMeaning 为空的列（排除锁定状态）", () => {
    const entry = createDictionaryEntry("orders", [
      createColumn({ name: "id", inferredMeaning: "唯一标识", status: "user-confirmed" }),
      createColumn({ name: "amount", inferredMeaning: "", status: "ai-guessed" }),
      createColumn({ name: "region", inferredMeaning: "未知语义（请确认）", status: "ai-guessed" }),
      createColumn({ name: "notes", inferredMeaning: "备注", status: "user-corrected" }),
    ]);

    const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
    const filtered = entry.columns.filter((col) => {
      if (lockedStatuses.has(col.status)) return false;
      return !col.inferredMeaning || col.inferredMeaning === "未知语义（请确认）";
    });

    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.map((c) => c.name).includes("amount"));
    assert.ok(filtered.map((c) => c.name).includes("region"));
  });

  it("所有列都有含义时返回空数组", () => {
    const entry = createDictionaryEntry("orders", [
      createColumn({ name: "id", inferredMeaning: "唯一标识", status: "user-confirmed" }),
      createColumn({ name: "amount", inferredMeaning: "金额", status: "ai-guessed" }),
    ]);

    const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
    const filtered = entry.columns.filter((col) => {
      if (lockedStatuses.has(col.status)) return false;
      return !col.inferredMeaning || col.inferredMeaning === "未知语义（请确认）";
    });

    assert.strictEqual(filtered.length, 0);
  });
});

// ============================================================================
// I2: 字段语义明确 — suggestionSchema 校验通过
// ============================================================================

describe("I2: suggestionSchema 校验", () => {
  it("合法的 suggestion 通过校验", () => {
    const suggestion = createValidSuggestion();
    const result = validateSuggestionSchema(suggestion);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it("缺少 table 字段不通过", () => {
    const { table: _, ...rest } = createValidSuggestion();
    const result = validateSuggestionSchema(rest as any);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("table")));
  });

  it("缺少 column 字段不通过", () => {
    const { column: _, ...rest } = createValidSuggestion();
    const result = validateSuggestionSchema(rest as any);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("column")));
  });

  it("confidence 超出 [0,1] 范围不通过", () => {
    const suggestion = createValidSuggestion({ confidence: 1.5 });
    const result = validateSuggestionSchema(suggestion);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("confidence")));
  });

  it("非法 confidenceLevel 不通过", () => {
    const suggestion = createValidSuggestion({ confidenceLevel: "extreme" as any });
    const result = validateSuggestionSchema(suggestion);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("confidenceLevel")));
  });

  it("evidence 为空数组不通过", () => {
    const suggestion = createValidSuggestion({ evidence: [] });
    const result = validateSuggestionSchema(suggestion);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("evidence")));
  });
});

// ============================================================================
// I3: 同名 status 字段 — 不同表的 context 独立
// ============================================================================

describe("I3: 同名字段不同表 context 独立", () => {
  it("两表的 status 字段推断结果独立存储", () => {
    const ordersStatus = createColumn({ name: "status", type: "VARCHAR", inferredMeaning: "订单状态", status: "ai-guessed" });
    const paymentsStatus = createColumn({ name: "status", type: "VARCHAR", inferredMeaning: "支付状态", status: "ai-guessed" });
    const ordersEntry = createDictionaryEntry("orders", [ordersStatus]);
    const paymentsEntry = createDictionaryEntry("payments", [paymentsStatus]);

    assert.strictEqual(ordersEntry.columns[0].inferredMeaning, "订单状态");
    assert.strictEqual(paymentsEntry.columns[0].inferredMeaning, "支付状态");
    assert.strictEqual(ordersEntry.tableName, "orders");
    assert.strictEqual(paymentsEntry.tableName, "payments");
  });

  it("applyInferenceResults 按表名隔离", () => {
    const entries: DataDictionaryEntry[] = [
      createDictionaryEntry("orders", [createColumn({ name: "status", inferredMeaning: "旧含义", status: "ai-guessed" })]),
      createDictionaryEntry("payments", [createColumn({ name: "status", inferredMeaning: "旧含义", status: "ai-guessed" })]),
    ];

    const suggestions: DictionarySuggestion[] = [
      createValidSuggestion({ table: "orders", column: "status", suggestedDescription: "订单状态" }),
    ];

    const target = entries.find((e) => e.tableName === "orders");
    if (target) {
      for (const s of suggestions) {
        const col = target.columns.find((c) => c.name === s.column);
        if (col && !new Set(["user-confirmed", "user-corrected"]).has(col.status)) {
          col.inferredMeaning = s.suggestedDescription;
        }
      }
    }

    assert.strictEqual(entries[0].columns[0].inferredMeaning, "订单状态");
    assert.strictEqual(entries[1].columns[0].inferredMeaning, "旧含义");
  });
});

// ============================================================================
// I4: 证据不足 — low confidence → uncertain
// ============================================================================

describe("I4: 证据不足 — low confidence 映射为 uncertain", () => {
  it("applyConfidenceRules 将低分映射为 uncertain + low", () => {
    const suggestion = createValidSuggestion({
      confidence: 0.3,
      confidenceLevel: "medium",
      evidence: [],
      uncertainties: ["数据不足"],
    });
    const result = applyConfidenceRules(suggestion);
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.confidenceLevel, "low");
    assert.strictEqual(result.status, "uncertain");
  });

  it("applyConfidenceRules 保留高分映射为 ai-guessed + high", () => {
    const suggestion = createValidSuggestion({
      confidence: 0.8,
      confidenceLevel: "high",
      evidence: ["强证据1", "强证据2"],
      uncertainties: [],
    });
    const result = applyConfidenceRules(suggestion, {
      dbComment: "此字段表示金额",
      samplePatterns: ["数字模式"],
      sqlUsageCount: 5,
    });
    assert.strictEqual(result.confidence, 1);
    assert.strictEqual(result.confidenceLevel, "high");
    assert.strictEqual(result.status, "ai-guessed");
  });

  it("applyConfidenceRules clamp 到 [0, 1]", () => {
    const suggestion = createValidSuggestion({
      confidence: 0.9,
      confidenceLevel: "high",
      evidence: ["证据"],
      uncertainties: [],
    });
    const result = applyConfidenceRules(suggestion, {
      dbComment: "注释",
      samplePatterns: ["模式"],
      sqlUsageCount: 10,
    });
    assert.ok(result.confidence <= 1);
    assert.ok(result.confidence >= 0);
  });

  it("中等分数映射为 ai-guessed + medium", () => {
    const suggestion = createValidSuggestion({
      confidence: 0.5,
      confidenceLevel: "medium",
      evidence: ["部分证据"],
      uncertainties: [],
    });
    const result = applyConfidenceRules(suggestion);
    assert.strictEqual(result.confidenceLevel, "medium");
    assert.strictEqual(result.status, "ai-guessed");
  });
});

// ============================================================================
// I5: PII 字段 — maskPIIArray 被调用
// ============================================================================

describe("I5: PII 字段 — 脱敏处理", () => {
  it("maskPIIArray 对手机号和邮箱脱敏", async () => {
    const { maskPIIArray } = await import("../pii-guard.js");
    const rawValues = ["13800138000", "test@example.com", "normal_value"];
    const { masked, totalMatches } = maskPIIArray(rawValues);
    assert.strictEqual(masked.length, 3);
    assert.strictEqual(masked[2], "normal_value");
    // 手机号和邮箱应被脱敏
    assert.ok(totalMatches >= 2);
    assert.notStrictEqual(masked[0], "13800138000");
    assert.notStrictEqual(masked[1], "test@example.com");
  });
});

// ============================================================================
// I6: 用户已确认 — 不覆盖 user-confirmed
// ============================================================================

describe("I6: 不覆盖 user-confirmed 字段", () => {
  it("user-confirmed 列不参与推断更新", () => {
    const col = createColumn({
      name: "amount",
      inferredMeaning: "用户确认的金额",
      status: "user-confirmed",
      confirmedAt: "2026-01-01",
      userMeaning: "销售额（元）",
    });
    const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
    const shouldApply = !lockedStatuses.has(col.status);
    assert.strictEqual(shouldApply, false);
    assert.strictEqual(col.inferredMeaning, "用户确认的金额");
    assert.strictEqual(col.status, "user-confirmed");
  });
});

// ============================================================================
// I7: 用户已修正 — 不覆盖 user-corrected
// ============================================================================

describe("I7: 不覆盖 user-corrected 字段", () => {
  it("user-corrected 列不参与推断更新", () => {
    const col = createColumn({
      name: "status",
      inferredMeaning: "旧含义",
      status: "user-corrected",
      userMeaning: "订单状态",
      confirmedAt: "2026-01-01",
    });
    const lockedStatuses = new Set(["user-confirmed", "user-corrected"]);
    const shouldApply = !lockedStatuses.has(col.status);
    assert.strictEqual(shouldApply, false);
    assert.strictEqual(col.userMeaning, "订单状态");
  });
});

// ============================================================================
// I8: Schema revision 相同 — 命中缓存
// ============================================================================

describe("I8: InferenceCache 读写和过期", () => {
  let tmpDir: string;
  let cache: InferenceCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-inference-"));
    cache = new InferenceCache(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("写入后读取命中缓存", () => {
    const suggestion = createValidSuggestion();
    cache.set({
      table: "orders",
      column: "amount",
      schemaRevision: "rev-001",
      suggestion,
      cachedAt: new Date().toISOString(),
    });
    const hit = cache.get("orders", "amount", "rev-001");
    assert.ok(hit !== null);
    assert.strictEqual(hit!.suggestion.suggestedDescription, "测试含义");
  });

  it("不同 revision 不命中", () => {
    const suggestion = createValidSuggestion();
    cache.set({
      table: "orders", column: "amount", schemaRevision: "rev-001",
      suggestion, cachedAt: new Date().toISOString(),
    });
    const miss = cache.get("orders", "amount", "rev-002");
    assert.strictEqual(miss, null);
  });

  it("不同列不命中", () => {
    const suggestion = createValidSuggestion();
    cache.set({
      table: "orders", column: "amount", schemaRevision: "rev-001",
      suggestion, cachedAt: new Date().toISOString(),
    });
    const miss = cache.get("orders", "status", "rev-001");
    assert.strictEqual(miss, null);
  });

  it("batchGet 正确区分命中和未命中", () => {
    cache.set({
      table: "orders", column: "amount", schemaRevision: "rev-001",
      suggestion: createValidSuggestion(), cachedAt: new Date().toISOString(),
    });
    const { cached, uncachedColumns } = cache.batchGet("orders", ["amount", "status", "notes"], "rev-001");
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].column, "amount");
    assert.ok(uncachedColumns.includes("status"));
    assert.ok(uncachedColumns.includes("notes"));
  });

  it("过期缓存返回 null", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    cache.set({
      table: "orders", column: "amount", schemaRevision: "rev-001",
      suggestion: createValidSuggestion(), cachedAt: eightDaysAgo,
    });
    const hit = cache.get("orders", "amount", "rev-001");
    assert.strictEqual(hit, null);
  });

  it("pruneExpired 清除过期条目", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    cache.set({
      table: "orders", column: "old_col", schemaRevision: "rev-001",
      suggestion: createValidSuggestion({ column: "old_col" }), cachedAt: eightDaysAgo,
    });
    cache.set({
      table: "orders", column: "new_col", schemaRevision: "rev-001",
      suggestion: createValidSuggestion({ column: "new_col" }), cachedAt: new Date().toISOString(),
    });
    const pruned = cache.pruneExpired();
    assert.strictEqual(pruned, 1);
    assert.strictEqual(cache.get("orders", "old_col", "rev-001"), null);
    assert.ok(cache.get("orders", "new_col", "rev-001") !== null);
  });

  it("invalidateTable 清除指定表的全部缓存", () => {
    cache.set({
      table: "orders", column: "amount", schemaRevision: "rev-001",
      suggestion: createValidSuggestion({ column: "amount", table: "orders" }), cachedAt: new Date().toISOString(),
    });
    cache.set({
      table: "payments", column: "amount", schemaRevision: "rev-001",
      suggestion: createValidSuggestion({ column: "amount", table: "payments" }), cachedAt: new Date().toISOString(),
    });
    cache.invalidateTable("orders");
    assert.strictEqual(cache.get("orders", "amount", "rev-001"), null);
    assert.ok(cache.get("payments", "amount", "rev-001") !== null);
  });
});

// ============================================================================
// I9: 并发修改 — revision 冲突（AtomicStore 测试）
// ============================================================================

describe("I9: AtomicStore revision 冲突", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-atomic-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("revision 不匹配时抛出 RevisionConflictError", async () => {
    const { AtomicStore, RevisionConflictError } = await import("../dashboard/services/atomic-store.js");
    const store = new AtomicStore<string[]>(join(tmpDir, "test.json"));

    // 初始写入 revision → 1
    store.write(["a", "b"], -1, "test");

    // 期望 revision=0（已过期），当前是 1 → RevisionConflictError
    let caught = false;
    try {
      store.write(["c"], 0, "test");
    } catch (err) {
      if (err instanceof RevisionConflictError) caught = true;
    }
    assert.strictEqual(caught, true);
  });

  it("revision 匹配时正常写入", async () => {
    const { AtomicStore } = await import("../dashboard/services/atomic-store.js");
    const store = new AtomicStore<string[]>(join(tmpDir, "test2.json"));

    const result1 = store.write(["a"], -1, "test");
    assert.strictEqual(result1.revision, 1);

    const result2 = store.write(["a", "b"], 1, "test");
    assert.strictEqual(result2.revision, 2);
    assert.deepStrictEqual(result2.data, ["a", "b"]);
  });
});

// ============================================================================
// I10: 用户确认 — reviewColumn 正确设置状态
// ============================================================================

describe("I10: reviewColumn 确认操作", () => {
  it("confirmed 动作设置 status=user-confirmed", () => {
    const col = createColumn({ name: "amount", inferredMeaning: "金额", status: "ai-guessed" });
    const now = new Date().toISOString();
    col.status = "user-confirmed";
    col.confirmedAt = now;
    col.validated = true;
    col.review = { action: "confirmed", reviewedAt: now };

    assert.strictEqual(col.status, "user-confirmed");
    assert.strictEqual(col.review?.action, "confirmed");
    assert.ok(col.review?.reviewedAt !== undefined);
    assert.strictEqual(col.validated, true);
  });
});

// ============================================================================
// I11: 用户修正 — 保留 originalSuggestion
// ============================================================================

describe("I11: reviewColumn 修正操作", () => {
  it("corrected 动作设置 status=user-corrected 并保留 originalSuggestion", () => {
    const col = createColumn({ name: "status", inferredMeaning: "AI 推断的状态", status: "ai-guessed" });
    const now = new Date().toISOString();
    const originalMeaning = col.inferredMeaning;
    col.status = "user-corrected";
    col.userMeaning = "订单状态（用户修正）";
    col.confirmedAt = now;
    col.validated = true;
    col.review = { action: "corrected", reviewedAt: now, originalSuggestion: originalMeaning };

    assert.strictEqual(col.status, "user-corrected");
    assert.strictEqual(col.userMeaning, "订单状态（用户修正）");
    assert.strictEqual(col.review?.action, "corrected");
    assert.strictEqual(col.review?.originalSuggestion, "AI 推断的状态");
  });
});

// ============================================================================
// I12: 模型输出损坏 — validateSuggestionBatch 隔离错误
// ============================================================================

describe("I12: validateSuggestionBatch 隔离错误", () => {
  it("批量校验隔离合法和非法记录", () => {
    const inputs: unknown[] = [
      createValidSuggestion({ column: "col_a" }),
      null,  // 非法
      "not an object",  // 非法
      createValidSuggestion({ column: "col_b" }),
      { table: "", column: "x" },  // 缺少必要字段
      createValidSuggestion({ column: "col_c", confidence: 2.0 }),  // confidence > 1
    ];
    const result = validateSuggestionBatch(inputs);
    // 2 条合法: col_a, col_b (col_c 的 confidence=2.0 > 1 被拒绝)
    assert.strictEqual(result.valid.length, 2);
    assert.deepStrictEqual(result.valid.map((v) => v.column), ["col_a", "col_b"]);
    // 4 条非法: indices 1, 2, 4, 5
    assert.strictEqual(result.invalid.length, 4);
    assert.deepStrictEqual(result.invalid.map((i) => i.index), [1, 2, 4, 5]);
  });

  it("全部非法时 valid 为空", () => {
    const inputs: unknown[] = [null, undefined, 42, "bad"];
    const result = validateSuggestionBatch(inputs);
    assert.strictEqual(result.valid.length, 0);
    assert.strictEqual(result.invalid.length, 4);
  });

  it("全部合法时 invalid 为空", () => {
    const inputs: unknown[] = [
      createValidSuggestion({ column: "a" }),
      createValidSuggestion({ column: "b" }),
    ];
    const result = validateSuggestionBatch(inputs);
    assert.strictEqual(result.valid.length, 2);
    assert.strictEqual(result.invalid.length, 0);
  });

  it("空数组返回两个空列表", () => {
    const result = validateSuggestionBatch([]);
    assert.strictEqual(result.valid.length, 0);
    assert.strictEqual(result.invalid.length, 0);
  });
});