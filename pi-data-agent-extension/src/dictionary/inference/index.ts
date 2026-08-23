/**
 * 字典推断模块 — 统一导出
 */

export { inferDictionary } from "./infer-dictionary.js";
export type { InferDictionaryParams } from "./infer-dictionary.js";
export { collectInferenceContext } from "./collect-inference-context.js";
export type { CollectContextParams } from "./collect-inference-context.js";
export { InferenceCache } from "./inference-cache.js";
export { validateSuggestionSchema, validateSuggestionBatch } from "./suggestion-schema.js";
export { applyConfidenceRules } from "./confidence-evaluator.js";
export type { ColumnEvidenceInfo } from "./confidence-evaluator.js";
// Re-export 内部类型
export type { InferenceResult } from "./types.js";
export type {
  DictionarySuggestion,
  TableInferenceContext,
  DictionaryInferenceMode,
  DictionaryInferenceCacheEntry,
} from "../../types.js";