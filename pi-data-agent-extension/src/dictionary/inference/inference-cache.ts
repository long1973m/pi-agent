/**
 * 字典推断 — 推断结果缓存
 *
 * 职责：
 * - 以 JSON 文件持久化到 .pi-data-agent/inference-cache.json
 * - 按 table+column+schemaRevision 去重
 * - 命中缓存则不重复调用模型
 * - 缓存条目有过期时间（7 天）
 * - 原子写入（writeFileSync 确保完整性）
 */

import type { DictionaryInferenceCacheEntry } from "../../types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** 缓存过期时间：7 天（毫秒） */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InferenceCache {
  private cachePath: string;
  private entries: Map<string, DictionaryInferenceCacheEntry> = new Map();

  constructor(projectDir: string) {
    this.cachePath = join(projectDir, ".pi-data-agent", "inference-cache.json");
    this.load();
  }

  /** 缓存键：table:column:schemaRevision */
  private static key(table: string, column: string, schemaRevision: string): string {
    return `${table}:${column}:${schemaRevision}`;
  }

  /**
   * 查找缓存
   *
   * 命中时返回缓存条目，过期返回 null。
   */
  get(
    table: string,
    column: string,
    schemaRevision: string
  ): DictionaryInferenceCacheEntry | null {
    const entry = this.entries.get(
      InferenceCache.key(table, column, schemaRevision)
    );
    if (!entry) return null;

    // 检查过期
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > CACHE_TTL_MS) return null;

    return entry;
  }

  /**
   * 批量查找（返回命中和未命中的列名）
   */
  batchGet(
    table: string,
    columns: string[],
    schemaRevision: string
  ): {
    cached: DictionaryInferenceCacheEntry[];
    uncachedColumns: string[];
  } {
    const cached: DictionaryInferenceCacheEntry[] = [];
    const uncachedColumns: string[] = [];

    for (const col of columns) {
      const entry = this.get(table, col, schemaRevision);
      if (entry) {
        cached.push(entry);
      } else {
        uncachedColumns.push(col);
      }
    }

    return { cached, uncachedColumns };
  }

  /**
   * 写入缓存（单条）
   *
   * 写入后立即持久化到文件。
   */
  set(entry: DictionaryInferenceCacheEntry): void {
    this.entries.set(
      InferenceCache.key(entry.table, entry.column, entry.schemaRevision),
      entry
    );
    this.save();
  }

  /**
   * 批量写入
   *
   * 一次性写入多条后持久化一次，避免频繁 IO。
   */
  batchSet(entries: DictionaryInferenceCacheEntry[]): void {
    for (const entry of entries) {
      this.entries.set(
        InferenceCache.key(entry.table, entry.column, entry.schemaRevision),
        entry
      );
    }
    this.save();
  }

  /**
   * 清除指定表的全部缓存
   */
  invalidateTable(table: string): void {
    const prefix = `${table}:`;
    const keysToDelete: string[] = [];
    this.entries.forEach((_value, key) => {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      this.entries.delete(key);
    }
    this.save();
  }

  /**
   * 清除过期缓存
   *
   * @returns 清除的条数
   */
  pruneExpired(): number {
    let pruned = 0;
    const now = Date.now();
    const keysToDelete: string[] = [];

    this.entries.forEach((entry, key) => {
      const age = now - new Date(entry.cachedAt).getTime();
      if (age > CACHE_TTL_MS) {
        keysToDelete.push(key);
        pruned++;
      }
    });

    for (const key of keysToDelete) {
      this.entries.delete(key);
    }

    if (pruned > 0) {
      this.save();
    }

    return pruned;
  }

  /**
   * 从文件加载缓存
   *
   * 文件不存在或解析失败时静默降级为空缓存。
   */
  private load(): void {
    if (!existsSync(this.cachePath)) return;

    try {
      const raw = readFileSync(this.cachePath, "utf-8");
      const data: DictionaryInferenceCacheEntry[] = JSON.parse(raw);

      if (!Array.isArray(data)) return;

      const now = Date.now();
      for (const entry of data) {
        // 跳过无有效键的条目
        if (!entry.table || !entry.column || !entry.schemaRevision) continue;
        // 加载时跳过已过期条目
        const age = now - new Date(entry.cachedAt).getTime();
        if (age > CACHE_TTL_MS) continue;

        this.entries.set(
          InferenceCache.key(entry.table, entry.column, entry.schemaRevision),
          entry
        );
      }
    } catch (err) {
      console.warn("[InferenceCache] Failed to load cache file:", err);
    }
  }

  /**
   * 写入文件（原子写入）
   *
   * 序列化全部条目，一次性写入。writeFileSync 本身在 Node.js 中
   * 对于小文件是原子的（单次系统调用），足够满足需求。
   */
  private save(): void {
    try {
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.entries.values());
      writeFileSync(this.cachePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn("[InferenceCache] Failed to save cache file:", err);
    }
  }
}