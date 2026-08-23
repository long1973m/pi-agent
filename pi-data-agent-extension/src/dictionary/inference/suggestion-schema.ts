/**
 * 字典推断 — JSON Schema 校验
 *
 * 职责：校验模型输出的 DictionarySuggestion 结构是否符合要求。
 * 不依赖外部 JSON Schema 库，手写校验逻辑，保持零依赖。
 */

import type { DictionarySuggestion } from "../../types.js";

/** 单条校验结果 */
interface SingleValidationResult {
  valid: boolean;
  errors: string[];
}

/** 批量校验结果 */
interface BatchValidationResult {
  valid: DictionarySuggestion[];
  invalid: Array<{ index: number; errors: string[] }>;
}

const VALID_CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const VALID_STATUSES = new Set(["ai-guessed", "uncertain"]);

/**
 * 校验模型输出的单条 DictionarySuggestion
 *
 * 校验项：
 * - table 和 column 必须非空
 * - suggestedDescription 必须非空
 * - confidence 必须在 0-1 之间
 * - confidenceLevel 必须为 high/medium/low
 * - status 必须为 ai-guessed 或 uncertain
 * - evidence 必须是非空数组
 * - generatedAt 必须是合法 ISO 日期
 */
export function validateSuggestionSchema(
  suggestion: unknown
): SingleValidationResult {
  const errors: string[] = [];

  if (typeof suggestion !== "object" || suggestion === null) {
    return { valid: false, errors: ["suggestion 不是对象"] };
  }

  const s = suggestion as Record<string, unknown>;

  // table
  if (typeof s.table !== "string" || s.table.trim() === "") {
    errors.push("table 必须是非空字符串");
  }

  // column
  if (typeof s.column !== "string" || s.column.trim() === "") {
    errors.push("column 必须是非空字符串");
  }

  // suggestedDescription
  if (typeof s.suggestedDescription !== "string" || s.suggestedDescription.trim() === "") {
    errors.push("suggestedDescription 必须是非空字符串");
  }

  // suggestedAliases — 可选，但必须是字符串数组
  if (s.suggestedAliases !== undefined) {
    if (!Array.isArray(s.suggestedAliases)) {
      errors.push("suggestedAliases 必须是数组");
    } else if (!s.suggestedAliases.every((a) => typeof a === "string")) {
      errors.push("suggestedAliases 中所有元素必须是字符串");
    }
  }

  // confidence
  if (typeof s.confidence !== "number" || s.confidence < 0 || s.confidence > 1) {
    errors.push("confidence 必须是 0-1 之间的数字");
  }

  // confidenceLevel
  if (!VALID_CONFIDENCE_LEVELS.has(s.confidenceLevel as string)) {
    errors.push(`confidenceLevel 必须是 ${Array.from(VALID_CONFIDENCE_LEVELS).join("/")} 之一`);
  }

  // status
  if (!VALID_STATUSES.has(s.status as string)) {
    errors.push(`status 必须是 ${Array.from(VALID_STATUSES).join("/")} 之一`);
  }

  // evidence — 必须是非空数组
  if (!Array.isArray(s.evidence)) {
    errors.push("evidence 必须是数组");
  } else if (s.evidence.length === 0) {
    errors.push("evidence 不能为空数组");
  } else if (!s.evidence.every((e) => typeof e === "string")) {
    errors.push("evidence 中所有元素必须是字符串");
  }

  // uncertainties — 可选，但必须是字符串数组
  if (s.uncertainties !== undefined) {
    if (!Array.isArray(s.uncertainties)) {
      errors.push("uncertainties 必须是数组");
    } else if (!s.uncertainties.every((u) => typeof u === "string")) {
      errors.push("uncertainties 中所有元素必须是字符串");
    }
  }

  // modelVersion
  if (typeof s.modelVersion !== "string" || s.modelVersion.trim() === "") {
    errors.push("modelVersion 必须是非空字符串");
  }

  // generatedAt — ISO 日期校验
  if (typeof s.generatedAt !== "string") {
    errors.push("generatedAt 必须是字符串");
  } else {
    const d = new Date(s.generatedAt);
    if (isNaN(d.getTime())) {
      errors.push("generatedAt 必须是合法 ISO 日期");
    }
  }

  // sourceSchemaRevision — 可选，由服务端注入（Spec §10.3）
  // 模型不需要生成此字段，由 infer-dictionary.ts 在写入缓存时注入
  if (s.sourceSchemaRevision !== undefined) {
    if (typeof s.sourceSchemaRevision !== "string" || (s.sourceSchemaRevision as string).trim() === "") {
      errors.push("sourceSchemaRevision 如果提供必须是非空字符串");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 批量校验
 *
 * 将输入数组中的每条记录分别校验，返回通过和未通过的两部分。
 */
export function validateSuggestionBatch(
  suggestions: unknown[]
): BatchValidationResult {
  const valid: DictionarySuggestion[] = [];
  const invalid: Array<{ index: number; errors: string[] }> = [];

  for (let i = 0; i < suggestions.length; i++) {
    const result = validateSuggestionSchema(suggestions[i]);
    if (result.valid) {
      valid.push(suggestions[i] as DictionarySuggestion);
    } else {
      invalid.push({ index: i, errors: result.errors });
    }
  }

  return { valid, invalid };
}