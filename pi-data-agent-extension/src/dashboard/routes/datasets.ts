/**
 * Dashboard — 数据集路由
 *
 * GET /api/datasets
 * GET /api/datasets/:table/preview?rows=50
 * GET /api/datasets/:table/schema
 * GET /api/datasets/:table/stats?mode=auto
 * GET /api/datasets/:table/profile   （v0.10.2 数据体检常驻化）
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { DatasetReader } from "../services/dataset-reader.js";
import { profileTable } from "../../hooks/data-profile.js";
import type { DashboardDependencies } from "../server.js";
import { PREVIEW_MAX_ROWS } from "../config.js";
import { normalizeSql } from "../../utils/sql-normalizer.js";
import { quoteSqlIdentifier } from "../../utils/sql.js";
import { TableCardStore } from "../../table-cards/store.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("datasets");

export interface DatasetDependencies extends DashboardDependencies {
  /** DuckDB 引擎（只读连接） */
  engine: import("../../engine/duckdb.js").DuckDBEngine | null;
}

// 查询缓存，有效期5分钟
const queryCache = new Map<string, { data: unknown; expireAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

/**
 * 获取缓存key
 *
 * key 格式 `<prefix>:<table>:<hash>`——显式带表名分段，
 * 使删表时能按表名精确失效（见 invalidateTableCache）。
 */
function getCacheKey(prefix: string, table: string, params: Record<string, string | number>): string {
  const str = JSON.stringify(params);
  return `${prefix}:${table}:${createHash("md5").update(str).digest("hex")}`;
}

/** 获取缓存数据 */
function getCache<T>(key: string): T | null {
  const cached = queryCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expireAt) {
    queryCache.delete(key);
    return null;
  }
  return cached.data as T;
}

/**
 * 按表名失效缓存条目
 *
 * key 格式为 `<prefix>:<table>:<hash>`，按分段比对而非字符串包含，
 * 避免表名互为子串时误删（`sales` 不应失效 `sales_detail` 的缓存）。
 */
function invalidateTableCache(table: string): number {
  let removed = 0;
  for (const key of Array.from(queryCache.keys())) {
    const parts = key.split(":");
    if (parts.length >= 3 && parts[1] === table) {
      queryCache.delete(key);
      removed++;
    }
  }
  return removed;
}

/** 设置缓存数据 */
function setCache(key: string, data: unknown): void {
  // 缓存超过100条时，清理最旧的条目
  if (queryCache.size >= 100) {
    const now = Date.now();
    for (const [k, v] of queryCache) {
      if (now > v.expireAt) {
        queryCache.delete(k);
      }
    }
    // 如果还是超过100条，删除最早的10条
    if (queryCache.size >= 100) {
      const keys = Array.from(queryCache.keys()).slice(0, 10);
      keys.forEach(k => queryCache.delete(k));
    }
  }
  queryCache.set(key, { data, expireAt: Date.now() + CACHE_TTL });
}

export function createDatasetsRouter(deps: DatasetDependencies): Router {
  const router = Router();
  const reader = new DatasetReader(deps.engine);

  /** 数据集列表 */
  router.get("/api/datasets", async (_req: Request, res: Response) => {
    try {
      const datasets = await reader.listDatasets();
      res.json({
        data: datasets,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取数据集列表失败";
      res.status(500).json({
        error: { code: "DATASETS_LIST_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 数据预览 */
  router.get("/api/datasets/:table/preview", async (req: Request, res: Response) => {
    const table = req.params.table as string;
    let rows = parseInt(req.query.rows as string, 10) || undefined;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (rows !== undefined && (rows < 1 || rows > PREVIEW_MAX_ROWS)) {
      res.status(413).json({
        error: { code: "ROWS_LIMIT_EXCEEDED", message: `预览行数不能超过 ${PREVIEW_MAX_ROWS}` },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const cacheKey = getCacheKey("preview", table, { table, rows: rows || 50 });
      const cached = getCache(cacheKey);
      if (cached) {
        res.json({
          data: cached,
          meta: { requestId: randomUUID(), cached: true },
        });
        return;
      }

      const result = await reader.preview(table, rows);
      setCache(cacheKey, result);
      res.json({
        data: result,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "数据预览失败";
      const statusCode = msg.includes("不存在") ? 404 : 500;
      res.status(statusCode).json({
        error: { code: "DATASET_PREVIEW_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 表 Schema */
  router.get("/api/datasets/:table/schema", async (req: Request, res: Response) => {
    const table = req.params.table as string;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const cacheKey = getCacheKey("schema", table, { table });
      const cached = getCache(cacheKey);
      if (cached) {
        res.json({
          data: cached,
          meta: { requestId: randomUUID(), cached: true },
        });
        return;
      }

      const schema = await reader.getSchema(table);
      setCache(cacheKey, schema);
      res.json({
        data: schema,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取 Schema 失败";
      const statusCode = msg.includes("不存在") ? 404 : 500;
      res.status(statusCode).json({
        error: { code: "DATASET_SCHEMA_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 列统计 */
  router.get("/api/datasets/:table/stats", async (req: Request, res: Response) => {
    const table = req.params.table as string;
    const mode = (req.query.mode as string || "auto") as "auto" | "full" | "approximate" | "sample";

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const cacheKey = getCacheKey("stats", table, { table, mode });
      const cached = getCache(cacheKey);
      if (cached) {
        res.json({
          data: cached,
          meta: { requestId: randomUUID(), cached: true },
        });
        return;
      }

      const result = await reader.getStats(table, mode);
      setCache(cacheKey, result);
      res.json({
        data: result,
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取列统计失败";
      const statusCode = msg.includes("不存在") ? 404 : 500;
      res.status(statusCode).json({
        error: { code: "DATASET_STATS_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /** 数据体检（v0.10.2 常驻化：任意选中表随时可取画像，不再限于上传后一次性展示） */
  router.get("/api/datasets/:table/profile", async (req: Request, res: Response) => {
    const table = req.params.table as string;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (!deps.engine) {
      res.status(503).json({
        error: { code: "ENGINE_UNAVAILABLE", message: "DuckDB 引擎不可用" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const tables = await deps.engine.getTables();
      if (!tables.includes(table)) {
        res.status(404).json({
          error: { code: "TABLE_NOT_FOUND", message: `表 ${table} 不存在` },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      const profile = await profileTable(deps.engine, table);
      res.json({
        data: { profile },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "数据体检失败";
      res.status(500).json({
        error: { code: "DATASET_PROFILE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  /**
   * 删除表（DROP TABLE）
   *
   * **不可逆**：DuckDB 采用文件模式持久化，DROP 即从库文件移除，无回收站、无事务回滚。
   *
   * 防护链（由外到内）：
   * 1. writeTokenGuard —— 全局中间件，DELETE 属写方法，缺令牌 403
   * 2. 表名白名单正则 —— 与 GET 路由同一套
   * 3. 请求体必须携带 `confirm` 且等于表名 —— 挡误触与脚本误删
   * 4. 只允许删 engine.getTables() 可见的表 —— 该列表只含 main schema，
   *    ATTACH 进来的外部库表（SQLite 及未来的 MySQL/PostgreSQL）不在其中，
   *    因此**删不到外部库**，这是刻意保留的安全边界
   *
   * 级联清理：查询缓存 + 表卡片 + 字典条目，避免"表没了、资产还在"的孤儿态。
   * 清理单项失败不回滚 DROP（表已删，回滚反而更不一致），只记录日志并在响应中如实返回。
   *
   * **不删 .uploads/ 下的源文件**：表→源文件映射未持久化（load_data 不记录来源路径），
   * 反查不可靠，误删用户原始数据的风险高于收益。响应里提示用户自行处理。
   */
  router.delete("/api/datasets/:table", async (req: Request, res: Response) => {
    const table = req.params.table as string;

    if (!/^[\w-]+$/.test(table)) {
      res.status(400).json({
        error: { code: "INVALID_TABLE_NAME", message: "无效的表名" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    const confirm = (req.body as { confirm?: unknown } | undefined)?.confirm;
    if (confirm !== table) {
      res.status(400).json({
        error: {
          code: "CONFIRM_REQUIRED",
          message: `删除表不可撤销，请求体需携带 confirm 字段且值等于表名 "${table}"`,
        },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    if (!deps.engine) {
      res.status(503).json({
        error: { code: "ENGINE_UNAVAILABLE", message: "DuckDB 引擎不可用" },
        meta: { requestId: randomUUID() },
      });
      return;
    }

    try {
      const tables = await deps.engine.getTables();
      if (!tables.includes(table)) {
        res.status(404).json({
          error: { code: "TABLE_NOT_FOUND", message: `表 ${table} 不存在` },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // 1) 删表本体
      await deps.engine.exec(`DROP TABLE ${quoteSqlIdentifier(table)}`);

      // 2) 级联清理关联资产
      const cleaned: { queryCache: number; tableCard: boolean; dictionary: boolean } = {
        queryCache: 0,
        tableCard: false,
        dictionary: false,
      };

      cleaned.queryCache = invalidateTableCache(table);

      try {
        cleaned.tableCard = new TableCardStore(deps.projectDir).remove(table);
      } catch (cardErr) {
        logger.debug(`清理表卡片失败 ${table}: ${cardErr instanceof Error ? cardErr.message : String(cardErr)}`);
      }

      try {
        cleaned.dictionary = deps.dictionaryManager?.removeDictionary(table) ?? false;
      } catch (dictErr) {
        logger.debug(`清理字典条目失败 ${table}: ${dictErr instanceof Error ? dictErr.message : String(dictErr)}`);
      }

      res.json({
        data: {
          table,
          dropped: true,
          cleaned,
          note: "表已从 DuckDB 中删除（不可撤销）。上传的源数据文件未被删除，如需清理请手动处理。",
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "删除表失败";
      res.status(500).json({
        error: { code: "DATASET_DELETE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  return router;
}
