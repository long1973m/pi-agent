/**
 * S2.1 load-data — 加载数据文件到 DuckDB
 *
 * 支持格式：CSV, TSV, Parquet, JSON, Excel（.xlsx/.xls）
 * - CSV/TSV/Parquet/JSON：DuckDB read_csv_auto / read_json_auto 自动检测
 * - Excel：Node 侧 SheetJS 解析 → 临时 CSV → 复用 read_csv_auto（类型推断与 CSV 一致）
 *
 * 流程：安全层路径检查 → DuckDB CREATE TABLE AS SELECT → 返回表概览
 *
 * v0.9：
 * - 抽出共享加载函数 loadFileIntoTable，供 load_data 工具与 Dashboard 上传自动加载共用
 * - 加载成功后 best-effort 生成"数据体检卡"（hooks/data-profile.ts，失败静默跳过）
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { basename, extname, join } from "node:path";
import { statSync, existsSync, writeFileSync, unlinkSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";
import type { TableOverview } from "../types.js";
import { formatQueryResult } from "./tool-context.js";
import { resolveConfirmGate } from "../security.js";
import { executeWithRecovery, recoveryResultToToolResult } from "../error-recovery.js";
import type { DuckDBEngine } from "../engine/duckdb.js";
import type { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { profileTable, formatProfileCard, type TableProfile } from "../hooks/data-profile.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("load-data");

/** 文件大小阈值（500MB），超过时提示用户确认 */
const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;

/** Excel 解析防护：单文件总 cell 数上限（防 zip bomb） */
const MAX_EXCEL_CELLS = 5_000_000;

/** Excel 解析防护：转换后 CSV 文本体积上限 */
const MAX_EXCEL_CSV_BYTES = 200 * 1024 * 1024;

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** load-data 参数 */
const LoadDataParams = Type.Object({
  file_path: Type.String({ description: "数据文件路径（CSV/TSV/Parquet/JSON/Excel）" }),
  format: Type.Optional(Type.String({
    description: "文件格式（csv/tsv/parquet/json/xlsx），省略时自动检测",
  })),
  table_name: Type.Optional(Type.String({
    description: "目标表名，省略时用文件名（去扩展名）",
  })),
  sheet_name: Type.Optional(Type.String({
    description: "Excel 工作表名（仅 .xlsx/.xls），省略时取第一个 sheet",
  })),
});

/** 从文件路径推导表名（load_data 与上传自动加载共用同一规则） */
export function deriveTableName(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function detectFormat(filePath: string, format?: string): string {
  if (format) return format.toLowerCase();
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const map: Record<string, string> = {
    csv: "csv", tsv: "tsv", parquet: "parquet", pq: "parquet",
    json: "json", jsonl: "json", ndjson: "json",
    xlsx: "excel", xls: "excel",
  };
  return map[ext] ?? "csv";
}

/** magic bytes 兜底：内容以 PK\x03\x04 开头（zip 容器，xlsx 的底层格式） */
function looksLikeExcelBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** 读取文件头部若干字节（用于 magic bytes 检测） */
function readMagicBytes(filePath: string, bytes = 4): Buffer | null {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function buildDuckDBReadSql(filePath: string, format: string): string {
  // 转义 SQL 字符串中的单引号
  const safePath = filePath.replace(/'/g, "''");
  switch (format) {
    case "csv":
      return `read_csv_auto('${safePath}')`;
    case "tsv":
      return `read_csv_auto('${safePath}', delim='\t')`;
    case "parquet":
      return `read_parquet('${safePath}')`;
    case "json":
      return `read_json_auto('${safePath}')`;
    default:
      return `read_csv_auto('${safePath}')`;
  }
}

// ============================================================================
// Excel → 临时 CSV 转换（A-1）
// ============================================================================

/** Excel 源准备结果 */
interface ExcelSource {
  kind: "excel";
  /** 转换出的临时 CSV 路径（加载完成后必须 cleanup） */
  csvPath: string;
  availableSheets: string[];
  selectedSheet: string;
  cleanup: () => void;
}

/** 非 Excel 源 */
interface DirectSource {
  kind: "direct";
  readSql: string;
  cleanup?: () => void;
}

/** 源准备失败（人话 reason） */
export class LoadSourceError extends Error {
  /** Excel 场景下的可用 sheet 列表（便于用户换 sheet 重试） */
  availableSheets?: string[];
}

/**
 * 将 Excel 文件的指定 sheet 转换为临时 CSV，复用 CSV 加载路径。
 *
 * 防护：
 * - 总 cell 数 > 5×10⁶ 拒绝（防 zip bomb）
 * - 转换后 CSV 文本 > 200MB 拒绝
 * - 解析失败给出人话提示（伪装文件、损坏文件）
 */
function prepareExcelSource(filePath: string, sheetName?: string): ExcelSource {
  // 文件头校验：SheetJS 对纯文本会回退成 CSV 解析（静默产出错误数据），
  // 因此先验 magic bytes——xlsx 是 zip 容器（PK\x03\x04），老 .xls 是 OLE2（D0 CF 11 E0）
  const magic = readMagicBytes(filePath, 8);
  const isZipContainer = !!magic && magic[0] === 0x50 && magic[1] === 0x4b;
  const isOle2 = !!magic && magic[0] === 0xd0 && magic[1] === 0xcf && magic[2] === 0x11 && magic[3] === 0xe0;
  if (!isZipContainer && !isOle2) {
    throw new LoadSourceError(
      "文件不是有效的 Excel 文件（文件头校验失败），可能只是改了扩展名的文本/CSV。"
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    const buffer = statSync(filePath) && readExcelBuffer(filePath);
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    throw new LoadSourceError(
      `文件可能不是有效的 Excel 文件（解析失败: ${err instanceof Error ? err.message : String(err)}）`
    );
  }

  const availableSheets = workbook.SheetNames;
  if (availableSheets.length === 0) {
    throw new LoadSourceError("Excel 文件中没有任何工作表。");
  }

  // cell 数防护（解析后基于 !ref 范围估算）
  let totalCells = 0;
  for (const name of availableSheets) {
    const ref = workbook.Sheets[name]?.["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    totalCells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
  }
  if (totalCells > MAX_EXCEL_CELLS) {
    throw new LoadSourceError(
      `Excel 文件过大（约 ${totalCells} 个单元格，上限 ${MAX_EXCEL_CELLS}），已拒绝加载以防资源耗尽。`
    );
  }

  // 选定 sheet：省略时取第一个
  const selectedSheet = sheetName ?? availableSheets[0];
  const sheet = workbook.Sheets[selectedSheet];
  if (!sheet) {
    const err = new LoadSourceError(
      `找不到工作表 "${sheetName}"。可用 sheet：${availableSheets.join(", ")}`
    );
    err.availableSheets = availableSheets;
    throw err;
  }

  const csvText = XLSX.utils.sheet_to_csv(sheet);
  if (!csvText.trim()) {
    throw new LoadSourceError(`工作表 "${selectedSheet}" 是空的，没有可加载的数据。`);
  }
  if (Buffer.byteLength(csvText, "utf-8") > MAX_EXCEL_CSV_BYTES) {
    throw new LoadSourceError(
      `工作表 "${selectedSheet}" 转换后超过 200MB，已拒绝加载以防资源耗尽。`
    );
  }

  const csvPath = join(tmpdir(), `pi-data-agent_xlsx_${Date.now()}_${randomUUID().slice(0, 8)}.csv`);
  writeFileSync(csvPath, csvText, "utf-8");

  return {
    kind: "excel",
    csvPath,
    availableSheets,
    selectedSheet,
    cleanup: () => {
      try { unlinkSync(csvPath); } catch { /* 清理失败不影响主流程 */ }
    },
  };
}

function readExcelBuffer(filePath: string): Buffer {
  return readFileSync(filePath);
}

/**
 * 准备加载源：Excel 走临时 CSV 转换，其余直接构造 DuckDB read 函数。
 *
 * 格式识别：扩展名优先，magic bytes（PK\x03\x04）兜底。
 */
function prepareLoadSource(filePath: string, format: string, sheetName?: string): ExcelSource | DirectSource {
  let effectiveFormat = format;

  // magic bytes 兜底：扩展名识别为 csv（含未知扩展名回退）但内容像 xlsx
  if (effectiveFormat === "csv" && existsSync(filePath)) {
    const magic = readMagicBytes(filePath);
    if (magic && looksLikeExcelBuffer(magic)) {
      effectiveFormat = "excel";
    }
  }

  if (effectiveFormat === "excel") {
    return prepareExcelSource(filePath, sheetName);
  }
  return { kind: "direct", readSql: buildDuckDBReadSql(filePath, effectiveFormat) };
}

// ============================================================================
// 共享加载函数（A-2：load_data 工具与 Dashboard 上传自动加载共用）
// ============================================================================

/** loadFileIntoTable 选项 */
export interface LoadFileOptions {
  /** 数据文件路径 */
  filePath: string;
  /** 目标表名，省略时从文件名推导 */
  tableName?: string;
  /** 文件格式，省略时按扩展名自动检测 */
  format?: string;
  /** Excel 工作表名（仅 Excel），省略时取第一个 sheet */
  sheetName?: string;
}

/** loadFileIntoTable 钩子（静默字典生成、表卡片起草等） */
export interface LoadFileHooks {
  /** 数据字典管理器（可选，提供时静默生成/刷新字典） */
  dataDictionary?: Pick<DataDictionaryManager, "hasDictionary" | "ensureDictionary" | "refreshFingerprint"> | null;
  /** v0.10 A-3: 表卡片起草（可选；实现方内部 fire-and-forget + 失败静默）。
   *  v0.10.1 起默认调用方不再传入——仅保留机制供显式注入/测试 */
  tableCards?: {
    ensureCard: (tableName: string) => Promise<unknown>;
  } | null;
}

/** 加载失败结果 */
export interface LoadFileFailure {
  ok: false;
  /** 人话原因 */
  reason: string;
  availableSheets?: string[];
}

/** loadTableFast 返回的概览（附估算标记） */
type FastTableOverview = TableOverview & { rowCountEstimated?: boolean };

/** 加载成功结果 */
export interface LoadFileSuccess {
  ok: true;
  tableName: string;
  overview: FastTableOverview;
  /** 实际使用的格式（magic bytes 兜底后可能与传入不同） */
  format: string;
  /** Excel：全部 sheet 名 */
  availableSheets?: string[];
  /** Excel：实际加载的 sheet 名 */
  selectedSheet?: string;
  /** 同名表已存在并被覆盖 */
  replaced: boolean;
  loadDurationMs: number;
  dictionaryGenerated: boolean;
}

export type LoadFileOutcome = LoadFileSuccess | LoadFileFailure;

/**
 * 将文件加载为 DuckDB 表（共享实现）。
 *
 * - 引擎错误（SQL 失败等）会抛出异常，由调用方决定重试/降级；
 *   Excel 解析类错误返回 { ok: false, reason }（确定性失败，不值得重试）。
 * - 临时 CSV 在加载完成后（无论成败）清理。
 * - 提供 dataDictionary 时静默生成/刷新字典（失败不影响加载结果）。
 */
export async function loadFileIntoTable(
  engine: DuckDBEngine,
  options: LoadFileOptions,
  hooks?: LoadFileHooks
): Promise<LoadFileOutcome> {
  const tableName = options.tableName || deriveTableName(options.filePath);
  const format = detectFormat(options.filePath, options.format);

  // 1. 准备源（Excel 解析失败 → 人话 reason，不抛异常）
  let source: ExcelSource | DirectSource;
  try {
    source = prepareLoadSource(options.filePath, format, options.sheetName);
  } catch (err) {
    if (err instanceof LoadSourceError) {
      return { ok: false, reason: err.message, availableSheets: err.availableSheets };
    }
    throw err;
  }

  const startTime = Date.now();
  const readPath = source.kind === "excel" ? source.csvPath : options.filePath;
  const safeTable = engine.quoteIdentifier(tableName);
  const loadSql = `CREATE OR REPLACE TABLE ${safeTable} AS SELECT * FROM ${source.kind === "excel" ? buildDuckDBReadSql(source.csvPath, "csv") : source.readSql}`;

  try {
    // 2. 同名表检测（CREATE OR REPLACE 总是覆盖，标记是否发生了替换）
    let replaced = false;
    try {
      const existing = await engine.query(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = '${tableName.replace(/'/g, "''")}'`
      );
      replaced = Number(existing.rows[0]?.[0] ?? 0) > 0;
    } catch {
      // 检测失败不影响加载
    }

    // 3. 建表 + 快速概览
    await engine.exec(loadSql);
    const overview = await engine.loadTableFast(tableName);

    // 4. 静默字典生成（best-effort）
    let dictGenerated = false;
    const dict = hooks?.dataDictionary;
    if (dict) {
      try {
        if (!dict.hasDictionary(tableName)) {
          await dict.ensureDictionary(tableName, engine);
          dictGenerated = true;
        }
        await dict.refreshFingerprint(tableName, engine);
      } catch (dictErr) {
        logger.warn(`Auto dictionary generation failed for ${tableName}:`, dictErr);
      }
    }

    // 5. v0.10 A-3: 表卡片起草（fire-and-forget：不阻塞、失败静默；
    //    同 fingerprint 卡片跳过，结构变化标 stale，新表 AI 起草或骨架卡）
    const tableCards = hooks?.tableCards;
    if (tableCards) {
      void tableCards
        .ensureCard(tableName)
        .catch((err) => logger.debug(`Table card draft skipped for ${tableName}:`, err));
    }

    return {
      ok: true,
      tableName,
      overview,
      format: source.kind === "excel" ? "excel" : format,
      availableSheets: source.kind === "excel" ? source.availableSheets : undefined,
      selectedSheet: source.kind === "excel" ? source.selectedSheet : undefined,
      replaced,
      loadDurationMs: Date.now() - startTime,
      dictionaryGenerated: dictGenerated,
    };
  } finally {
    source.cleanup?.();
  }
}

// ============================================================================
// load_data 工具
// ============================================================================

export function createLoadDataTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "load_data",
    label: "Load Data",
    description:
      "Load a data file (CSV/TSV/Parquet/JSON/Excel) into DuckDB as a queryable table. " +
      "For Excel (.xlsx/.xls), optionally specify sheet_name (defaults to the first sheet). " +
      "Returns table overview with row count and column info, plus a data profile card with suggested questions.",
    parameters: LoadDataParams,
    execute: async (
      toolCallId: string,
      args: { file_path: string; format?: string; table_name?: string; sheet_name?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "load_data", error: "engine not available" },
        };
      }

      // 1. 解析参数
      const format = detectFormat(args.file_path, args.format);
      const tableName = args.table_name || deriveTableName(args.file_path);

      // 2. 安全检查（路径 + SQL）。SQL 预览用原始路径，仅做模式匹配；
      //    Excel 实际读取的是我们生成的临时 CSV，原始文件路径已在此处过白名单。
      const sql = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM ${buildDuckDBReadSql(args.file_path, format === "excel" ? "csv" : format)}`;
      const check = rt.security.checkOperation({ filePath: args.file_path, sql });
      if (check.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${check.reason}` }],
          details: { toolName: "load_data", blocked: true, reason: check.reason },
        };
      }
      if (check.action === "confirm") {
        const gate = resolveConfirmGate(check.confirmMessage!, {
          autoConfirmWrite: rt.config.autoConfirmWrite,
          hasUi: Boolean(ctx.ui),
        });
        if (gate.action === "block") {
          return {
            content: [{ type: "text", text: `Security blocked: ${gate.reason}` }],
            details: { toolName: "load_data", blocked: true, reason: gate.reason },
          };
        }
        if (gate.action === "confirm") {
          const confirmed = await ctx.ui.confirm("Load Data", gate.confirmMessage, { timeout: 30000 });
          if (!confirmed) {
            return {
              content: [{ type: "text", text: "Operation cancelled by user." }],
              details: { toolName: "load_data", cancelled: true },
            };
          }
        }
      }

      // 2.5. 文件大小检查
      let fileSize: number | undefined;
      let fileSizeFormatted: string | undefined;
      try {
        if (existsSync(args.file_path)) {
          const stats = statSync(args.file_path);
          fileSize = stats.size;
          fileSizeFormatted = formatFileSize(fileSize);

          // 大文件确认门同样 fail-closed（v0.11 S-1）
          if (fileSize > LARGE_FILE_THRESHOLD) {
            const confirmMsg =
              `文件大小: ${fileSizeFormatted}\n\n` +
              `大文件加载可能消耗大量内存和磁盘空间，且耗时较长。\n` +
              `建议确认文件内容正确后再加载。\n\n` +
              `是否继续加载？`;
            const gate = resolveConfirmGate(confirmMsg, {
              autoConfirmWrite: rt.config.autoConfirmWrite,
              hasUi: Boolean(ctx.ui),
            });
            if (gate.action === "block") {
              return {
                content: [{ type: "text", text: `Security blocked: ${gate.reason}` }],
                details: { toolName: "load_data", blocked: true, reason: gate.reason, fileSize, fileSizeFormatted },
              };
            }
            if (gate.action === "confirm") {
              const confirmed = await ctx.ui.confirm("Large File Warning", gate.confirmMessage, { timeout: 60000 });
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Operation cancelled by user (large file)." }],
                  details: { toolName: "load_data", cancelled: true, fileSize, fileSizeFormatted },
                };
              }
            }
          }

          // 进度提示
          if (onUpdate && fileSizeFormatted) {
            onUpdate({
              content: [{ type: "text", text: `Loading ${format === "excel" ? "EXCEL" : format.toUpperCase()} file (${fileSizeFormatted})...` }],
              details: { toolName: "load_data", loading: true, fileSize, fileSizeFormatted },
            });
          }
        }
      } catch {
        // 文件状态检查失败不影响加载流程
      }

      // 3. 加载数据（带错误恢复，共享实现）
      const loadStartTime = Date.now();

      const recovery = await executeWithRecovery(
        async () => {
          const outcome = await loadFileIntoTable(
            rt.engine!,
            {
              filePath: args.file_path,
              tableName,
              format: args.format,
              sheetName: args.sheet_name,
            },
            {
              dataDictionary: rt.dataDictionary,
              // v0.10.1: 不再在加载成功后 fire-and-forget 起草表卡片（AI 入口撤除）；
              // LoadFileHooks.tableCards 机制保留供显式传入，骨架卡兜底由 get_table_card 负责
            },
          );

          if (!outcome.ok) {
            // Excel 解析失败等确定性错误：直接作为结果返回（不值得重试）
            return {
              skipped: true as const,
              outcome,
            };
          }

          const overview = outcome.overview;
          const colList = overview.columns.map((c: { name: string; type: string }) => `${c.name} (${c.type})`).join(", ");

          const dictNote = outcome.dictionaryGenerated
            ? "\n\n⚠ Field semantics are AI-inferred (not yet confirmed). Run describe_data to review and confirm."
            : "";

          const loadDurationMs = Date.now() - loadStartTime;
          const sizeInfo = fileSizeFormatted ? `, ${fileSizeFormatted}` : '';
          const durationInfo = loadDurationMs > 1000
            ? `, ${((loadDurationMs) / 1000).toFixed(1)}s`
            : `, ${loadDurationMs}ms`;

          // 行数显示：估算值加 ~ 前缀，未知显示 "unknown"
          const rowCountDisplay = overview.rowCountEstimated
            ? (overview.rowCount >= 0 ? `~${overview.rowCount}` : "unknown")
            : String(overview.rowCount);

          // sheet 信息（仅 Excel）
          const sheetNote = outcome.availableSheets && outcome.availableSheets.length > 1
            ? `\nSheets: ${outcome.availableSheets.join(", ")}（当前: ${outcome.selectedSheet}，可用 sheet_name 参数换表重载）`
            : "";

          // 4. 数据体检卡（best-effort，失败静默跳过，不影响加载结果）
          let profileCard = "";
          let dataProfile: TableProfile | undefined;
          try {
            const profile = await profileTable(rt.engine!, tableName, {
              estimatedRowCount: overview.rowCount,
            });
            profileCard = `\n\n${formatProfileCard(profile)}`;
            dataProfile = profile;
          } catch (profileErr) {
            logger.debug(`Data profile skipped for ${tableName}:`, profileErr);
          }

          return {
            skipped: false as const,
            outcome,
            content: [{
              type: "text",
              text: `Loaded "${tableName}": ${rowCountDisplay} rows, ${overview.columnCount} columns${sizeInfo}${durationInfo}\n\nColumns: ${colList}${sheetNote}${dictNote}${profileCard}`,
            }],
            details: {
              toolName: "load_data",
              tableName: overview.name,
              rowCount: overview.rowCount,
              rowCountEstimated: overview.rowCountEstimated,
              columnCount: overview.columnCount,
              columns: overview.columns,
              source: args.file_path,
              format: outcome.format,
              selectedSheet: outcome.selectedSheet,
              availableSheets: outcome.availableSheets,
              replaced: outcome.replaced,
              dictionaryGenerated: outcome.dictionaryGenerated,
              dataProfile,
              fileSize,
              fileSizeFormatted,
              loadDurationMs: outcome.loadDurationMs,
            },
          };
        },
        {},
        {
          sql,
          tableName,
          engine: rt.engine,
          toolName: "load_data",
        },
        onUpdate ? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }], details: { recoveryUpdate: true } }) : undefined
      );

      // Excel 解析失败等：直接返回人话错误（不走重试结果格式）
      const recoveryResult = recovery.result as { skipped?: boolean; outcome?: LoadFileFailure } | undefined;
      if (recoveryResult?.skipped && recoveryResult.outcome && !recoveryResult.outcome.ok) {
        const failure = recoveryResult.outcome;
        const sheetHint = failure.availableSheets && failure.availableSheets.length > 0
          ? `\nAvailable sheets: ${failure.availableSheets.join(", ")}`
          : "";
        return {
          content: [{ type: "text", text: `Load failed: ${failure.reason}${sheetHint}` }],
          details: { toolName: "load_data", error: failure.reason, availableSheets: failure.availableSheets },
        };
      }

      return recoveryResultToToolResult(recovery, "load_data");
    },
  };
}
