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

export interface DatasetDependencies extends DashboardDependencies {
  /** DuckDB 引擎（只读连接） */
  engine: import("../../engine/duckdb.js").DuckDBEngine | null;
}

// 查询缓存，有效期5分钟
const queryCache = new Map<string, { data: unknown; expireAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

/** 获取缓存key */
function getCacheKey(prefix: string, params: Record<string, string | number>): string {
  const str = JSON.stringify(params);
  return `${prefix}:${createHash("md5").update(str).digest("hex")}`;
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
      const cacheKey = getCacheKey("preview", { table, rows: rows || 50 });
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
      const cacheKey = getCacheKey("schema", { table });
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
      const cacheKey = getCacheKey("stats", { table, mode });
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

  return router;
}
