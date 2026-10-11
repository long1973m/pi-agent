/**
 * Dashboard — 本地副本（物化）路由
 *
 * GET /api/materializations
 *
 * 返回 v0.14 materialize_remote_table 落地的本地副本清单，并对每条记录
 * 附带"当前状态"：本地表是否还在、当前行数、与物化时的远端行数漂移。
 * 只读——移除副本请回到对话里让 Agent 执行（DROP）。
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MaterializationStore, type MaterializationRecord } from "../../materialization-store.js";
import type { DashboardDependencies } from "../server.js";

/** 视图条目：记录 + 当前状态 */
interface MaterializationView extends MaterializationRecord {
  /** 本地表当前是否存在 */
  localExists: boolean;
  /** 本地表当前行数（表不存在时 null） */
  currentRows: number | null;
  /** 当前行数 - 物化时远端行数（null = 无法计算） */
  drift: number | null;
  /** 漂移方向：synced = 一致 / ahead = 本地更多 / stale = 本地少于物化时远端 */
  driftState: "synced" | "ahead" | "stale" | "unknown" | "dropped";
}

export function createMaterializationsRouter(deps: DashboardDependencies): Router {
  const router = Router();
  const store = new MaterializationStore(join(deps.projectDir, "materializations.json"));

  router.get("/api/materializations", async (_req: Request, res: Response) => {
    try {
      const records = store.list();
      const views: MaterializationView[] = [];

      for (const rec of records) {
        let currentRows: number | null = null;
        let localExists = false;

        if (deps.engine) {
          try {
            const check = await deps.engine.query(
              `SELECT COUNT(*)::BIGINT FROM duckdb_tables() WHERE NOT internal ` +
                `AND database_name = current_database() AND table_name = '${rec.targetTable.replace(/'/g, "''")}'`
            );
            localExists = Number(check.rows[0]?.[0] ?? 0) > 0;
            if (localExists) {
              const cnt = await deps.engine.query(
                `SELECT COUNT(*) FROM main."${rec.targetTable.replace(/"/g, '""')}"`
              );
              currentRows = Number(cnt.rows[0]?.[0] ?? 0);
            }
          } catch {
            // 引擎不可用时仅回传记录本身
          }
        }

        const drift =
          currentRows !== null ? currentRows - rec.sourceRowCount : null;
        const driftState: MaterializationView["driftState"] = !localExists
          ? deps.engine
            ? "dropped"
            : "unknown"
          : drift === null
            ? "unknown"
            : drift === 0
              ? "synced"
              : drift > 0
                ? "ahead"
                : "stale";

        views.push({ ...rec, localExists, currentRows, drift, driftState });
      }

      res.json({
        data: { items: views, total: views.length },
        meta: { requestId: randomUUID() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "获取物化清单失败";
      res.status(500).json({ error: { code: "MATERIALIZATIONS_ERROR", message: msg }, meta: { requestId: randomUUID() } });
    }
  });

  return router;
}
