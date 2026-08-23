/**
 * Dashboard — SQL 历史路由
 *
 * GET  /api/sql-history?page=1&size=20&status=&sort=recent|useCount&query=
 * PATCH /api/sql-history/:entryId
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { QueryMemoryReader } from "../services/query-memory-reader.js";
import { QueryMemoryStore, RevisionConflictError } from "../services/query-memory-store.js";
import { writeTokenGuard } from "../middleware/write-token.js";
import type { DashboardDependencies } from "../server.js";

export function createSqlHistoryRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const reader = new QueryMemoryReader(deps.projectDir, deps.engine);
  const store = new QueryMemoryStore(deps.projectDir);

  router.get("/api/sql-history", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string, 10) || undefined;
      const size = parseInt(req.query.size as string, 10) || undefined;
      const status = req.query.status as string | undefined;
      const sort = (req.query.sort as "recent" | "useCount") || undefined;
      const query = req.query.query as string | undefined;

      const result = await reader.list({ page, size, status, sort, query });

      // 从 AtomicStore 读取当前 revision 供前端乐观锁使用
      const revisioned = store.read();
      const revision = revisioned?.revision ?? 0;

      res.json({ data: result, revision, meta: { requestId: randomUUID() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取 SQL 历史失败";
      res.status(500).json({ error: { code: "SQL_HISTORY_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  router.patch("/api/sql-history/:entryId", writeTokenGuard, (req: Request, res: Response) => {
    const entryId = req.params.entryId;
    if (!/^[\w-]+$/.test(entryId)) {
      return res.status(400).json({ error: { code: "INVALID_ENTRY_ID", message: "无效的记录 ID" } });
    }

    const { userIntent, notes, status, pinned, expectedRevision } = req.body;

    // v0.10 A-5: pinned 必须是 boolean（区分"未传"与"取消固定"）
    if (pinned !== undefined && typeof pinned !== "boolean") {
      return res.status(400).json({ error: { code: "INVALID_PINNED", message: "pinned 只允许 boolean" } });
    }

    // status 枚举值（与前端和 QueryMemoryReader 保持一致）
    const validStatuses = ["active", "outdated", "archived", "failed"];
    if (status !== undefined && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { code: "INVALID_STATUS", message: "状态只允许 active/outdated/archived/failed" } });
    }

    try {
      const revisioned = store.read();
      if (!revisioned) {
        return res.status(404).json({ error: { code: "ENTRY_NOT_FOUND", message: "SQL 记录不存在" } });
      }

      const currentRevision = revisioned.revision;
      const memory = revisioned.data;

      // 乐观锁：检查 expectedRevision
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        return res.status(409).json({
          error: {
            code: "REVISION_CONFLICT",
            message: `数据已被其他会话修改（当前 revision ${currentRevision}，期望 ${expectedRevision}）。请刷新后重试。`,
            currentRevision,
          },
        });
      }

      const entry = memory.entries.find((e) => e.id === entryId);
      if (!entry) {
        return res.status(404).json({ error: { code: "ENTRY_NOT_FOUND", message: "SQL 记录不存在" } });
      }

      // 更新字段
      if (userIntent !== undefined) entry.naturalLanguageQuery = userIntent;
      if (notes !== undefined) entry.notes = notes;
      if (status !== undefined) entry.status = status;
      if (pinned !== undefined) entry.pinned = pinned;

      // 原子写入（AtomicStore 处理 revision 递增 + tmp/rename 原子替换）
      const result = store.write(memory, expectedRevision ?? -1);

      res.json({ data: entry, revision: result.revision, meta: { requestId: randomUUID() } });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        const current = store.read();
        return res.status(409).json({
          error: {
            code: "REVISION_CONFLICT",
            message: err.message,
            currentRevision: current?.revision ?? 0,
          },
        });
      }
      const msg = err instanceof Error ? err.message : "更新失败";
      res.status(500).json({ error: { code: "SQL_UPDATE_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  return router;
}
