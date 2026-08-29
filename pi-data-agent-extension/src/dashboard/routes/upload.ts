/**
 * Dashboard 文件上传路由
 *
 * POST /api/upload — 上传文件（base64 编码，JSON body）并自动加载进 DuckDB
 *   Request:  { filename: string, content: string (base64), format?: string }
 *   Response: { path, size, originalName, uploadedAt, loaded }
 *     loaded.ok = true  → { tableName, rowCount, columnCount, replaced, dataProfile? }
 *                          dataProfile 为结构化 TableProfile（v0.10 A-2），画像失败时静默省略
 *     loaded.ok = false → { reason }（人话原因，不影响上传本身）
 *
 * GET /api/files — 列出已上传的文件
 *   Response: [{ name, path, size, uploadedAt }]
 *
 * DELETE /api/files/:name — 删除上传的文件
 *
 * 注意：
 * - 为保护服务器内存，限制单文件 50MB（base64 编码后约 67MB）
 * - 文件名使用 UUID + 原始扩展名，防止路径遍历
 * - 仅支持本地访问（localOnly 中间件已限制）
 * - 自动加载：>100MB 跳过（避免阻塞串行队列）；失败不影响 HTTP 200 响应
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, readdirSync, unlinkSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { loadFileIntoTable, deriveTableName } from "../../tools/load-data.js";
import type { DuckDBEngine } from "../../engine/duckdb.js";
import type { DataDictionaryManager } from "../../hooks/data-dictionary.js";
import { profileTable } from "../../hooks/data-profile.js";
import type { TableProfile } from "../../hooks/data-profile.js";
import { createLogger } from "../../utils/logger.js";
import { formatFileSize } from "../../utils/format.js";

const logger = createLogger("upload");

/** 单个文件最大大小（50MB） */
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

/** 自动加载上限（100MB）：超过时跳过自动加载，避免阻塞 engine 串行队列 */
const AUTOLOAD_MAX_SIZE = 100 * 1024 * 1024;

/** 允许的扩展名 */
const ALLOWED_EXTENSIONS = new Set([".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".pq", ".xlsx", ".xls"]);

/** 文件名安全校验（防止路径遍历） */
function isSafeFilename(name: string): boolean {
  // 只允许字母、数字、下划线、连字符、点
  return /^[a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+$/.test(name);
}

/** 生成安全的存储文件名 */
function generateSafeFilename(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const uuid = randomUUID();
  const timestamp = Date.now();
  return `${timestamp}_${uuid}${ext}`;
}

/** 自动加载结果（附在上传响应中） */
export type AutoLoadResult =
  | { ok: true; tableName: string; rowCount: number; columnCount: number; replaced: boolean; dataProfile?: TableProfile }
  | { ok: false; reason: string };

/**
 * 上传后自动加载（best-effort，任何失败都返回人话 reason 而不抛异常）
 *
 * 独立导出便于测试 >100MB 跳过逻辑。
 */
export async function autoLoadUploadedFile(
  deps: {
    engine: DuckDBEngine | null;
    dataDictionary?: DataDictionaryManager | null;
  },
  params: { filePath: string; originalName: string; size: number }
): Promise<AutoLoadResult> {
  // 上限保护：大文件跳过自动加载（engine 为串行队列，避免阻塞 Dashboard 响应）
  if (params.size > AUTOLOAD_MAX_SIZE) {
    return {
      ok: false,
      reason: `文件较大（${formatFileSize(params.size)}），已跳过自动加载。可在 Agent 中说「加载 ${params.originalName}」手动加载。`,
    };
  }

  if (!deps.engine) {
    return { ok: false, reason: "DuckDB 引擎不可用，无法自动加载。请在 Agent 中手动加载数据。" };
  }

  try {
    const outcome = await loadFileIntoTable(
      deps.engine,
      {
        filePath: params.filePath,
        // 表名从原始文件名推导（sanitize 规则与 load_data 一致）
        tableName: deriveTableName(params.originalName),
      },
      { dataDictionary: deps.dataDictionary ?? null }
    );

    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }

    const result: AutoLoadResult = {
      ok: true,
      tableName: outcome.tableName,
      rowCount: outcome.overview.rowCount,
      columnCount: outcome.overview.columnCount,
      replaced: outcome.replaced,
    };

    // v0.10 A-2: 数据画像（best-effort，失败静默省略 dataProfile，不影响上传/建表结果）
    const engine = deps.engine;
    try {
      result.dataProfile = await profileTable(engine, outcome.tableName, {
        estimatedRowCount: outcome.overview.rowCount >= 0 ? outcome.overview.rowCount : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Profile failed for ${outcome.tableName}: ${msg}`);
    }

    // v0.10.1: 上传成功后不再自动触发表卡片 LLM 起草（AI 入口撤除），
    // 骨架卡兜底由 get_table_card 负责

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Auto load failed for ${params.originalName}: ${msg}`);
    return {
      ok: false,
      reason: `自动加载失败：${msg.slice(0, 200)}。文件已保存，可在 Agent 中重试加载。`,
    };
  }
}

export interface UploadDeps {
  /** 上传缓存目录 */
  uploadsDir: string;
  /** DuckDB 引擎（可选；提供时上传后自动加载建表） */
  engine?: DuckDBEngine | null;
  /** 数据字典管理器（可选；自动加载时静默生成字典） */
  dataDictionary?: DataDictionaryManager | null;
}

/** 创建上传路由 */
export function createUploadRouter(deps: UploadDeps): Router {
  const { uploadsDir } = deps;
  const router = Router();

  // ===== POST /api/upload =====
  router.post("/api/upload", async (req: Request, res: Response) => {
    try {
      const { filename, content, format } = req.body ?? {};

      // 参数校验
      if (typeof filename !== "string" || typeof content !== "string") {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "filename (string) and content (base64 string) are required" },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // 文件名安全检查
      if (!isSafeFilename(filename)) {
        res.status(400).json({
          error: { code: "INVALID_FILENAME", message: "文件名包含非法字符" },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // 扩展名检查
      const ext = extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.status(400).json({
          error: { code: "UNSUPPORTED_FORMAT", message: `不支持的文件格式: ${ext || "(无扩展名)"}` },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // base64 解码
      let buffer: Buffer;
      try {
        // 支持带 data URI 前缀的 base64: data:text/csv;base64,SGVsbG8...
        let b64 = content;
        const matches = content.match(/^data:[^;]+;base64,(.*)$/);
        if (matches) {
          b64 = matches[1];
        }
        buffer = Buffer.from(b64, "base64");
      } catch {
        res.status(400).json({
          error: { code: "DECODE_ERROR", message: "base64 解码失败，请检查文件内容" },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // 大小检查
      if (buffer.length > MAX_UPLOAD_SIZE) {
        res.status(413).json({
          error: {
            code: "FILE_TOO_LARGE",
            message: `文件大小 ${formatFileSize(buffer.length)} 超过限制 ${formatFileSize(MAX_UPLOAD_SIZE)}`,
          },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      // 生成安全文件名并保存
      const safeFilename = generateSafeFilename(filename);
      const filePath = join(uploadsDir, safeFilename);
      writeFileSync(filePath, buffer);

      const stats = statSync(filePath);

      logger.debug(`Saved: ${safeFilename} (${formatFileSize(stats.size)})`);

      // v0.9 A-2: 自动加载进 DuckDB（best-effort，失败不影响上传响应）
      const loaded = await autoLoadUploadedFile(
        {
          engine: deps.engine ?? null,
          dataDictionary: deps.dataDictionary ?? null,
        },
        { filePath, originalName: filename, size: stats.size }
      );
      if (!loaded.ok) {
        logger.debug(`Auto load skipped/failed for ${filename}: ${loaded.reason}`);
      }

      res.json({
        data: {
          path: filePath,
          name: safeFilename,
          originalName: filename,
          size: stats.size,
          sizeFormatted: formatFileSize(stats.size),
          format: format ?? ext.slice(1),
          uploadedAt: new Date().toISOString(),
          loaded,
        },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "上传失败";
      res.status(500).json({
        error: { code: "UPLOAD_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  // ===== GET /api/files =====
  router.get("/api/files", (_req: Request, res: Response) => {
    try {
      if (!existsSync(uploadsDir)) {
        res.json({ data: [], meta: { requestId: randomUUID() } });
        return;
      }

      const files = readdirSync(uploadsDir)
        .filter((name) => !name.startsWith("."))
        .map((name) => {
          const filePath = join(uploadsDir, name);
          const stats = statSync(filePath);
          return {
            name,
            path: filePath,
            size: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            uploadedAt: stats.birthtime.toISOString(),
          };
        })
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

      res.json({ data: files, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取文件列表失败";
      res.status(500).json({
        error: { code: "LIST_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  // ===== DELETE /api/files/:name =====
  router.delete("/api/files/:name", (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      // 安全检查
      if (!isSafeFilename(name) || name.includes("..")) {
        res.status(400).json({
          error: { code: "INVALID_FILENAME", message: "非法文件名" },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      const filePath = join(uploadsDir, name);

      if (!existsSync(filePath)) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "文件不存在" },
          meta: { requestId: randomUUID() },
        });
        return;
      }

      unlinkSync(filePath);
      logger.debug(`Deleted: ${name}`);

      res.json({ data: { deleted: true, name }, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "删除失败";
      res.status(500).json({
        error: { code: "DELETE_ERROR", message: msg },
        meta: { requestId: randomUUID() },
      });
    }
  });

  return router;
}
