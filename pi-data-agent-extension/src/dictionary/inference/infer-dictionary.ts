/**
 * 字典推断 — 核心推断流程
 *
 * 职责：编排完整的批量推断流程，包括缓存检查、模型调用、
 * JSON 解析、schema 校验、字段存在性校验、置信度修正、结果合并。
 *
 * 不直接写入字典，由调用方决定是否 applyInferenceResults。
 */

import type { DuckDBEngine } from "../../engine/duckdb.js";
import type { DataDictionaryManager } from "../../hooks/data-dictionary.js";
import type {
  DictionarySuggestion,
  DictionaryInferenceMode,
  DictionaryInferenceCacheEntry,
  TableInferenceContext,
} from "../../types.js";
import type { InferenceResult } from "./types.js";
import { collectInferenceContext } from "./collect-inference-context.js";
import { validateSuggestionBatch } from "./suggestion-schema.js";
import { InferenceCache } from "./inference-cache.js";
import { applyConfidenceRules, type ColumnEvidenceInfo } from "./confidence-evaluator.js";

/** 模型调用函数类型（依赖注入） */
type ModelCaller = (prompt: string, responseFormat?: object) => Promise<string>;

/** 每批最大字段数 */
const BATCH_SIZE = 100;

export interface InferDictionaryParams {
  tableName: string;
  engine: DuckDBEngine;
  dictionaryManager: DataDictionaryManager;
  mode: DictionaryInferenceMode;
  selectedColumns?: string[];
  modelVersion?: string;
  /** 模型调用函数（依赖注入，便于测试和替换） */
  callModel?: ModelCaller;
  /** 项目目录（用于缓存文件存储） */
  projectDir?: string;
}

/**
 * 批量推断字典字段含义
 *
 * 完整流程：
 * 1. 收集推断上下文
 * 2. 检查缓存（同表同 schemaRevision 的结果）
 * 3. 筛选未缓存的列
 * 4. 如果有未缓存的列，构建 prompt 并调用模型
 * 5. 解析模型输出 JSON
 * 6. schema 校验
 * 7. 字段存在性与类型校验
 * 8. 置信度规则修正
 * 9. 合并缓存结果和新结果
 * 10. 返回 InferenceResult
 *
 * 注意：不直接写入字典，由调用方决定是否 applyInferenceResults
 */
export async function inferDictionary(
  params: InferDictionaryParams
): Promise<InferenceResult> {
  const {
    tableName,
    engine,
    dictionaryManager,
    mode,
    selectedColumns,
    callModel,
    projectDir,
  } = params;

  const modelVersion = params.modelVersion ?? "unknown";
  const now = new Date().toISOString();

  // ========================================================================
  // 1. 收集推断上下文
  // ========================================================================
  const dictionaryEntry = dictionaryManager.getDictionary(tableName);
  const context = await collectInferenceContext({
    tableName,
    engine,
    dictionaryEntry,
    mode,
    selectedColumns,
  });

  // 如果没有需要推断的列，直接返回空结果
  if (context.columns.length === 0) {
    return {
      table: tableName,
      suggestions: [],
      errors: [],
      modelVersion,
      generatedAt: now,
      sourceSchemaRevision: "",
    };
  }

  // 计算 schemaRevision
  const schemaRevision = await dictionaryManager.computeFingerprint(
    tableName,
    engine
  );

  // 构建列名 → 上下文映射（供后续校验使用）
  const columnContextMap = new Map(
    context.columns.map((col) => [col.name, col])
  );

  // ========================================================================
  // 2-3. 检查缓存，筛选未缓存列
  // ========================================================================
  const cache = projectDir ? new InferenceCache(projectDir) : null;
  const allColumnNames = context.columns.map((col) => col.name);

  let cachedSuggestions: DictionarySuggestion[] = [];
  let uncachedColumns: string[] = allColumnNames;

  if (cache) {
    const batchResult = cache.batchGet(
      tableName,
      allColumnNames,
      schemaRevision
    );
    cachedSuggestions = batchResult.cached.map((e) => e.suggestion);
    uncachedColumns = batchResult.uncachedColumns;
  }

  // ========================================================================
  // 4-8. 如果有未缓存列，调用模型并处理结果
  // ========================================================================
  const newSuggestions: DictionarySuggestion[] = [];
  const newErrors: Array<{ column: string; error: string }> = [];

  if (uncachedColumns.length > 0) {
    // 检查 callModel 是否注入
    if (!callModel) {
      // 没有模型，未缓存列全部报错
      for (const col of uncachedColumns) {
        newErrors.push({ column: col, error: "AI 模型未配置，无法进行推断" });
      }
    } else {
      // 按组分批（每批 <= 100）
      const batches = chunkArray(uncachedColumns, BATCH_SIZE);

      for (const batch of batches) {
        const batchContext = {
          ...context,
          columns: context.columns.filter((col) => batch.includes(col.name)),
        };

        const batchResult = await inferBatch(
          tableName,
          batchContext,
          schemaRevision,
          modelVersion,
          callModel,
          columnContextMap
        );

        newSuggestions.push(...batchResult.suggestions);
        newErrors.push(...batchResult.errors);
      }

      // 写入缓存（仅成功的）
      if (cache && newSuggestions.length > 0) {
        const cacheEntries: DictionaryInferenceCacheEntry[] =
          newSuggestions.map((s) => ({
            table: tableName,
            column: s.column,
            schemaRevision,
            suggestion: s,
            cachedAt: now,
          }));
        cache.batchSet(cacheEntries);
      }
    }
  }

  // ========================================================================
  // 9. 合并缓存结果和新结果
  // ========================================================================
  const allSuggestions = [...cachedSuggestions, ...newSuggestions];

  // 去重（以 column 为主键，新结果优先）
  const dedupedMap = new Map<string, DictionarySuggestion>();
  for (const s of allSuggestions) {
    dedupedMap.set(s.column, s);
  }

  return {
    table: tableName,
    suggestions: Array.from(dedupedMap.values()),
    errors: newErrors,
    modelVersion,
    generatedAt: now,
    sourceSchemaRevision: schemaRevision,
  };
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/** 单批推断结果 */
interface BatchResult {
  suggestions: DictionarySuggestion[];
  errors: Array<{ column: string; error: string }>;
}

/**
 * 对一批列执行模型推断
 *
 * 流程：构建 prompt → 调用模型（失败重试一次） → 解析 JSON → 校验 → 置信度修正
 */
async function inferBatch(
  tableName: string,
  batchContext: TableInferenceContext,
  schemaRevision: string,
  modelVersion: string,
  callModel: ModelCaller,
  columnContextMap: Map<string, TableInferenceContext["columns"][0]>
): Promise<BatchResult> {
  const suggestions: DictionarySuggestion[] = [];
  const errors: Array<{ column: string; error: string }> = [];
  const targetColumns = batchContext.columns.map((c) => c.name);

  // 构建 prompt
  const prompt = buildPrompt(batchContext);

  // 调用模型（失败重试一次）
  let rawOutput: string | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      rawOutput = await callModel(prompt, {
        type: "json_schema",
        json_schema: {
          name: "dictionary_suggestions",
          strict: true,
          schema: SUGGESTION_RESPONSE_SCHEMA,
        },
      });
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) {
        // 两次都失败，所有列报错
        for (const col of targetColumns) {
          errors.push({
            column: col,
            error: `模型调用失败（重试 2 次）: ${lastError}`,
          });
        }
        return { suggestions: [], errors };
      }
    }
  }

  if (!rawOutput) {
    for (const col of targetColumns) {
      errors.push({ column: col, error: "模型返回空结果" });
    }
    return { suggestions: [], errors };
  }

  // 解析 JSON（parseModelOutput 内部已尝试直接解析 + 提取 JSON 块）
  let parsed: unknown;
  try {
    parsed = parseModelOutput(rawOutput);
  } catch {
    for (const col of targetColumns) {
      errors.push({
        column: col,
        error: `模型输出 JSON 解析失败`,
      });
    }
    return { suggestions: [], errors };
  }

  // 期望返回数组
  if (!Array.isArray(parsed)) {
    // 尝试从对象中提取 suggestions 字段
    if (parsed && typeof parsed === "object" && "suggestions" in parsed) {
      parsed = (parsed as Record<string, unknown>).suggestions;
    }
    if (!Array.isArray(parsed)) {
      for (const col of targetColumns) {
        errors.push({
          column: col,
          error: "模型输出格式不正确：期望 JSON 数组",
        });
      }
      return { suggestions: [], errors };
    }
  }

  // 为每条 suggestion 注入 sourceSchemaRevision（如果缺失）
  // Spec §10.3: sourceSchemaRevision 是元数据，由服务端注入而非模型生成
  for (const item of parsed as unknown[]) {
    if (item && typeof item === "object" && !("sourceSchemaRevision" in item)) {
      (item as Record<string, unknown>).sourceSchemaRevision = schemaRevision;
    }
  }

  // Schema 校验
  const { valid, invalid } = validateSuggestionBatch(parsed as unknown[]);

  // 处理校验通过的建议
  for (const suggestion of valid) {
    // 字段存在性校验
    if (!columnContextMap.has(suggestion.column)) {
      errors.push({
        column: suggestion.column,
        error: `字段 ${suggestion.column} 不在目标列中，已跳过`,
      });
      continue;
    }

    // 补充元数据
    const enriched: DictionarySuggestion = {
      ...suggestion,
      table: tableName,
      sourceSchemaRevision: schemaRevision,
      modelVersion: modelVersion,
      generatedAt: suggestion.generatedAt || new Date().toISOString(),
    };

    // 置信度规则修正
    const colInfo = columnContextMap.get(suggestion.column);
    const evidenceInfo: ColumnEvidenceInfo = {
      dbComment: colInfo?.dbComment,
      samplePatterns: colInfo?.sampleValues,
    };
    const adjusted = applyConfidenceRules(enriched, evidenceInfo);

    suggestions.push(adjusted);
  }

  // 处理校验失败的建议
  for (const item of invalid) {
    // 尝试从原始对象获取 column 名
    const rawObj = (parsed as unknown[])[item.index] as
      | Record<string, unknown>
      | undefined;
    const colName =
      rawObj && typeof rawObj === "object" && "column" in rawObj
        ? String(rawObj.column)
        : `unknown_index_${item.index}`;

    errors.push({
      column: colName,
      error: `Schema 校验失败: ${item.errors.join("; ")}`,
    });
  }

  return { suggestions, errors };
}

/**
 * 构建发送给模型的 prompt
 */
function buildPrompt(context: TableInferenceContext): string {
  const columnsDesc = context.columns
    .map((col) => {
      const parts = [
        `  - ${col.name} (${col.type}${col.nullable ? ", nullable" : ""})`,
      ];

      if (col.dbComment) {
        parts.push(`    注释: ${col.dbComment}`);
      }
      if (col.isPrimaryKey) parts.push("    [主键]");
      if (col.isForeignKey) parts.push("    [外键]");
      if (col.sampleValues.length > 0) {
        parts.push(`    样本值: ${col.sampleValues.join(", ")}`);
      }
      parts.push(
        `    空值率: ${(col.nullRatio * 100).toFixed(1)}%, 唯一值: ${col.uniqueCount}`
      );
      if (col.min !== undefined) parts.push(`    最小值: ${col.min}`);
      if (col.max !== undefined) parts.push(`    最大值: ${col.max}`);
      if (col.currentDescription) {
        parts.push(`    当前描述: ${col.currentDescription}`);
      }

      return parts.join("\n");
    })
    .join("\n");

  let prompt = `你是一个数据字典专家。请分析以下表的字段含义，为每个字段生成推断建议。

## 表信息
- 表名: ${context.tableName}
- 总行数: ${context.rowCount}
${context.tableComment ? `- 表注释: ${context.tableComment}` : ""}

## 字段列表
${columnsDesc}
`;

  if (context.knownCalibers && context.knownCalibers.length > 0) {
    prompt += `\n## 已确认字段含义（参考）
${context.knownCalibers.map((c) => `  - ${c}`).join("\n")}
`;
  }

  prompt += `
## 输出要求
请以 JSON 数组格式返回每个字段的推断建议，每个对象包含以下字段：
- column: 字段名（必须与输入字段名完全一致）
- suggestedDescription: 推断的语义描述（中文，简洁明确）
- suggestedAliases: 推断的别名列表（字符串数组，可选）
- confidence: 置信度分数（0-1）
- confidenceLevel: 置信度等级（high/medium/low）
- status: 状态（ai-guessed 或 uncertain）
- evidence: 推断依据列表（字符串数组，至少 1 条）
- uncertainties: 不确定点列表（字符串数组，可为空数组）
- modelVersion: "${context.columns.length > 0 ? "inferred" : "unknown"}"
- generatedAt: 当前 ISO 8601 时间
- sourceSchemaRevision: 留空（服务端填充）

注意：
1. 必须为输入中的每个字段都返回一条建议
2. table 字段留空（服务端填充）
3. sourceSchemaRevision 留空（服务端填充）
4. 优先结合字段名、类型、样本值和统计信息进行综合判断
5. 对于高置信度字段，evidence 应列出具体判断依据
6. 如果存在明显歧义，在 uncertainties 中说明

请直接返回 JSON 数组，不要包含 markdown 代码块标记。`;

  return prompt;
}

/**
 * 解析模型输出
 *
 * 尝试直接 JSON.parse，如果失败则尝试提取 JSON 块。
 */
function parseModelOutput(raw: string): unknown {
  // 直接尝试
  try {
    return JSON.parse(raw);
  } catch {
    // 继续尝试提取
  }

  // 提取 ```json ... ``` 或 ``` ... ``` 块
  const extracted = extractJsonBlock(raw);
  if (extracted) {
    return JSON.parse(extracted);
  }

  throw new Error("无法解析模型输出为 JSON");
}

/**
 * 从文本中提取 JSON 块
 */
function extractJsonBlock(raw: string): string | null {
  // 匹配 ```json ... ``` 或 ``` ... ```
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 匹配 [ ... ] 或 { ... }
  const bracketMatch = raw.match(/(\[[\s\S]*\])/);
  if (bracketMatch) {
    return bracketMatch[1].trim();
  }

  return null;
}

/**
 * 数组分块（每批 maxSize 个）
 */
function chunkArray<T>(arr: T[], maxSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += maxSize) {
    chunks.push(arr.slice(i, i + maxSize));
  }
  return chunks;
}

/**
 * 模型响应 JSON Schema（用于结构化输出提示）
 */
const SUGGESTION_RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      table: { type: "string" },
      column: { type: "string" },
      suggestedDescription: { type: "string" },
      suggestedAliases: {
        type: "array",
        items: { type: "string" },
      },
      confidence: { type: "number" },
      confidenceLevel: { type: "string", enum: ["high", "medium", "low"] },
      status: { type: "string", enum: ["ai-guessed", "uncertain"] },
      evidence: {
        type: "array",
        items: { type: "string" },
      },
      uncertainties: {
        type: "array",
        items: { type: "string" },
      },
      modelVersion: { type: "string" },
      generatedAt: { type: "string" },
      sourceSchemaRevision: { type: "string" },
    },
    required: [
      "column",
      "suggestedDescription",
      "confidence",
      "confidenceLevel",
      "status",
      "evidence",
      "modelVersion",
      "generatedAt",
    ],
    additionalProperties: false,
  },
};