/**
 * 字典推断模块 — 内部类型定义
 *
 * Re-export 共享类型 + 定义推断模块内部使用的类型
 */

import type { DictionarySuggestion } from "../../types.js";

// Re-export from types.ts
export type {
  DictionarySuggestion,
  TableInferenceContext,
  DictionaryInferenceMode,
  DictionaryInferenceCacheEntry,
} from "../../types.js";

/** 推断结果（含成功和失败字段） */
export interface InferenceResult {
  table: string;
  suggestions: DictionarySuggestion[];
  errors: Array<{
    column: string;
    error: string;
  }>;
  modelVersion: string;
  generatedAt: string;
  sourceSchemaRevision: string;
}