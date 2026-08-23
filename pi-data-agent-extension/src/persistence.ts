/**
 * Pi Data Agent — 三层持久化读写
 *
 * 层级：
 * - Global:  ~/.config/pi-data-agent/          (跨项目共享)
 * - Project: ./.pi-data-agent/                 (项目级)
 * - Session: 内存（session 生命周期内）         (运行时)
 *
 * 能力：读写 YAML/JSON 配置文件、session 数据恢复
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DataDictionaryEntry, QueryMemory, PersistableData, PersistenceLevel, CaliberEntry } from "./types.js";

/** 持久化管理器 */
export class PersistenceManager {
  private globalDir: string;
  private projectDir: string;
  private sessionCache: PersistableData = {};

  constructor(globalDir: string, projectDir: string) {
    this.globalDir = globalDir;
    this.projectDir = projectDir;
    this.ensureDirs();
  }

  /** 确保目录存在 */
  private ensureDirs(): void {
    mkdirSync(this.globalDir, { recursive: true });
    mkdirSync(this.projectDir, { recursive: true });
  }

  /** 获取某层级的文件路径 */
  private getFilePath(level: PersistenceLevel, filename: string): string {
    switch (level) {
      case "global":
        return join(this.globalDir, filename);
      case "project":
        return join(this.projectDir, filename);
      case "session":
        // session 层只存内存，不存文件
        throw new Error("Session level does not support file paths");
      default:
        throw new Error(`Unknown persistence level: ${level}`);
    }
  }

  /** 读取 JSON 文件 */
  private readJson<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      console.warn(`[Persistence] Failed to read ${path}`);
      return undefined;
    }
  }

  /** 写入 JSON 文件 */
  private writeJson(path: string, data: unknown): void {
    try {
      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[Persistence] Failed to write ${path}:`, err);
    }
  }

  // ============================================================================
  // 数据字典
  // ============================================================================

  /** 保存数据字典 */
  saveDataDictionary(entries: DataDictionaryEntry[], level: PersistenceLevel = "project"): void {
    if (level === "session") {
      this.sessionCache.dataDictionary = entries;
      return;
    }
    this.writeJson(this.getFilePath(level, "data-dictionary.json"), entries);
  }

  /** 读取数据字典 */
  loadDataDictionary(level: PersistenceLevel = "project"): DataDictionaryEntry[] | undefined {
    if (level === "session") {
      return this.sessionCache.dataDictionary;
    }
    const raw = this.readJson<DataDictionaryEntry[] | { data: DataDictionaryEntry[]; revision: number }>(
      this.getFilePath(level, "data-dictionary.json")
    );
    if (raw === undefined) return undefined;
    // 兼容 RevisionedData 格式（Dashboard v0.6 迁移后）
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && "data" in raw && Array.isArray(raw.data)) return raw.data;
    return undefined;
  }

  /** 合并所有层级的数据字典（session > project > global） */
  loadMergedDataDictionary(): Map<string, DataDictionaryEntry> {
    const result = new Map<string, DataDictionaryEntry>();

    // 优先级从低到高
    const levels: PersistenceLevel[] = ["global", "project", "session"];
    for (const level of levels) {
      const entries = this.loadDataDictionary(level);
      if (entries === undefined) continue;
      // 空数组表示该级别已明确清空数据，覆盖低级别结果
      if (entries.length === 0) {
        result.clear();
        continue;
      }
      for (const entry of entries) {
        result.set(entry.tableName, entry);
      }
    }

    return result;
  }

  // ============================================================================
  // 查询记忆
  // ============================================================================

  /** 保存查询记忆 */
  saveQueryMemory(memory: QueryMemory, level: PersistenceLevel = "project"): void {
    if (level === "session") {
      this.sessionCache.queryMemory = memory;
      return;
    }
    this.writeJson(this.getFilePath(level, "query-memory.json"), memory);
  }

  /** 读取查询记忆 */
  loadQueryMemory(level: PersistenceLevel = "project"): QueryMemory | undefined {
    if (level === "session") {
      return this.sessionCache.queryMemory;
    }
    const raw = this.readJson<QueryMemory | { data: QueryMemory; revision: number }>(
      this.getFilePath(level, "query-memory.json")
    );
    if (raw === undefined) return undefined;
    // 兼容 RevisionedData 格式（Dashboard AtomicStore 迁移后）
    if (raw && typeof raw === "object" && "data" in raw && raw.data && typeof raw.data === "object" && "entries" in raw.data) {
      return raw.data as QueryMemory;
    }
    // 旧版格式
    if (raw && typeof raw === "object" && "entries" in raw && Array.isArray((raw as { entries?: unknown }).entries)) {
      return raw as QueryMemory;
    }
    return undefined;
  }

  /** 合并所有层级的查询记忆 */
  loadMergedQueryMemory(): QueryMemory {
    const merged: QueryMemory = { maxEntries: 5, entries: [] };
    const seen = new Set<string>();

    for (const level of ["global", "project", "session"] as PersistenceLevel[]) {
      const memory = this.loadQueryMemory(level);
      if (!memory) continue;
      merged.maxEntries = Math.max(merged.maxEntries, memory.maxEntries);
      for (const entry of memory.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        merged.entries.push(entry);
      }
    }

    return merged;
  }

  // ============================================================================
  // Session 数据恢复
  // ============================================================================

  /** 保存完整的 session 状态 */
  saveSessionState(data: PersistableData): void {
    this.sessionCache = { ...data };
    // 同时持久化到 project 层，用于崩溃恢复
    this.writeJson(this.getFilePath("project", "session-state.json"), data);
  }

  /** 恢复 session 状态 */
  restoreSessionState(): PersistableData {
    // 优先从内存恢复
    if (this.sessionCache.dataDictionary || this.sessionCache.queryMemory) {
      return { ...this.sessionCache };
    }
    // 内存无数据，从 project 层恢复
    const saved = this.readJson<PersistableData>(
      this.getFilePath("project", "session-state.json")
    );
    if (saved) {
      this.sessionCache = saved;
    }
    return saved ?? {};
  }

  /** 清理 session 状态 */
  clearSessionState(): void {
    this.sessionCache = {};
    const path = this.getFilePath("project", "session-state.json");
    if (existsSync(path)) {
      rmSync(path);
    }
  }

  // ============================================================================
  // 通用配置读写
  // ============================================================================

  /** 读取配置 */
  readConfig<T>(key: string, level: PersistenceLevel = "project"): T | undefined {
    if (level === "session") {
      return this.sessionCache.config?.[key] as T | undefined;
    }
    const config = this.readJson<Record<string, unknown>>(
      this.getFilePath(level, "config.json")
    );
    return config?.[key] as T | undefined;
  }

  /** 写入配置 */
  writeConfig<T>(key: string, value: T, level: PersistenceLevel = "project"): void {
    if (level === "session") {
      this.sessionCache.config = { ...this.sessionCache.config, [key]: value };
      return;
    }
    const path = this.getFilePath(level, "config.json");
    const existing = this.readJson<Record<string, unknown>>(path) ?? {};
    existing[key] = value;
    this.writeJson(path, existing);
  }

  // ============================================================================
  // 口径记忆（agent.md）
  // ============================================================================

  /** 口径最大保留条数 */
  private static readonly MAX_CALIBER_ENTRIES = 10;

  /** 获取 agent.md 文件路径（project 级） */
  private getAgentMdPath(): string {
    return join(this.projectDir, "agent.md");
  }

  /** 读取所有口径条目 */
  loadCalibers(): CaliberEntry[] {
    const path = this.getAgentMdPath();
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as CaliberEntry[];
    } catch {
      console.warn(`[Persistence] Failed to read agent.md at ${path}`);
      return [];
    }
  }

  /** 写入单条口径（追加或更新，按 question 去重，截断到 MAX_CALIBER_ENTRIES） */
  saveCaliber(entry: CaliberEntry): void {
    try {
      const existing = this.loadCalibers();
      // 按 question 去重：如果已存在相同 question，更新为新选择
      const idx = existing.findIndex((e) => e.question === entry.question);
      if (idx >= 0) {
        existing[idx] = entry;
      } else {
        existing.push(entry);
      }
      // 截断：保留最近 MAX_CALIBER_ENTRIES 条
      const trimmed = existing.slice(-PersistenceManager.MAX_CALIBER_ENTRIES);
      writeFileSync(this.getAgentMdPath(), JSON.stringify(trimmed, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[Persistence] Failed to write agent.md:`, err);
    }
  }

  /** 检查某个 question 是否已有确认过的口径 */
  hasCaliberForQuestion(question: string): boolean {
    const calibers = this.loadCalibers();
    return calibers.some((e) => e.question === question && e.status === "confirmed");
  }

  /** 获取最近 N 条口径（用于注入 system prompt） */
  getRecentCalibers(count: number = 10): CaliberEntry[] {
    const calibers = this.loadCalibers();
    return calibers.slice(-count);
  }
}
