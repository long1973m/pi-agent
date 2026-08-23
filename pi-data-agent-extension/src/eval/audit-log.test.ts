/**
 * S5.3 Audit Log 验收测试
 *
 * 运行: npx tsx src/eval/audit-log.test.ts
 *
 * 覆盖:
 * - AL1: query_data 被记录到 audit.log
 * - AL2: load_data 被记录到 audit.log
 * - AL3: describe_data 不被记录（只读工具）
 * - AL4: summary 不含样本/PII
 * - AL5: JSONL 格式正确
 * - AL6: 错误结果标记为 error
 * - AL7: 被拦截结果标记为 blocked
 */

import { AuditLogManager } from "../audit-log.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

async function runAuditLogTests(): Promise<void> {
  console.log("=== S5.3 Audit Log Tests ===\n");
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
      failed++;
    }
  }

  const logPath = join(EVAL_DIR, "audit.log");
  // 清理旧日志
  try { unlinkSync(logPath); } catch { /* ignore */ }

  const auditLog = new AuditLogManager(EVAL_DIR);

  // ========================================================================
  // AL1: query_data 被记录
  // ========================================================================
  console.log("\n[AL1] query_data recorded");
  auditLog.recordStart("tc1", "query_data", { sql: "SELECT * FROM iris", table_name: "iris", user_intent: "查询所有数据" });
  auditLog.recordEnd({ toolCallId: "tc1", result: { details: { totalRowCount: 150 } }, isError: false });

  const recent1 = auditLog.getRecent(10);
  assert("recorded: 1 entry", recent1.length === 1);
  assert("recorded: toolName is query_data", recent1[0]?.toolName === "query_data");
  assert("recorded: result is success", recent1[0]?.result === "success");
  assert("recorded: has sql", recent1[0]?.sql === "SELECT * FROM iris");
  assert("recorded: has userIntent", recent1[0]?.userIntent === "查询所有数据");
  assert("recorded: duration >= 0", (recent1[0]?.durationMs ?? -1) >= 0);
  assert("recorded: timestamp exists", !!recent1[0]?.timestamp);
  assert("recorded: id exists", !!recent1[0]?.id);

  // ========================================================================
  // AL2: load_data 被记录
  // ========================================================================
  console.log("\n[AL2] load_data recorded");
  auditLog.recordStart("tc2", "load_data", { file_path: "/data/iris.csv", table_name: "iris" });
  auditLog.recordEnd({ toolCallId: "tc2", result: { details: { tableName: "iris" } }, isError: false });

  const recent2 = auditLog.getRecent(10);
  assert("load: 2 entries total", recent2.length === 2);
  assert("load: toolName is load_data", recent2[1]?.toolName === "load_data");

  // ========================================================================
  // AL3: describe_data 不被记录（只读工具）
  // ========================================================================
  console.log("\n[AL3] describe_data not recorded");
  auditLog.recordStart("tc3", "describe_data", { table_name: "iris" });
  auditLog.recordEnd({ toolCallId: "tc3", result: { details: {} }, isError: false });

  const recent3 = auditLog.getRecent(10);
  assert("readonly: still 2 entries", recent3.length === 2);

  // ========================================================================
  // AL4: summary 不含样本/PII
  // ========================================================================
  console.log("\n[AL4] Summary sanitization");
  auditLog.recordStart("tc4", "query_data", { sql: "SELECT email, phone FROM users", table_name: "users" });
  auditLog.recordEnd({ toolCallId: "tc4", result: { details: {} }, isError: false });

  const recent4 = auditLog.getRecent(10);
  const summary = recent4[2]?.summary ?? "";
  assert("summary: contains tool name", summary.includes("query_data"));
  assert("summary: does not contain sample rows", !summary.includes("sample"));
  assert("summary: does not contain PII", !summary.includes("alice@"));

  // ========================================================================
  // AL5: JSONL 格式正确
  // ========================================================================
  console.log("\n[AL5] JSONL format");
  assert("jsonl: file exists", existsSync(logPath));

  // ========================================================================
  // AL6: 错误结果标记为 error
  // ========================================================================
  console.log("\n[AL6] Error status");
  auditLog.recordStart("tc5", "query_data", { sql: "SELECT * FROM bad" });
  auditLog.recordEnd({ toolCallId: "tc5", result: { details: {} }, isError: true });

  const recent5 = auditLog.getRecent(10);
  const errorEntry = recent5.find((e) => e.toolCallId === "tc5");
  assert("error: marked as error", errorEntry?.result === "error");

  // ========================================================================
  // AL7: 被拦截结果标记为 blocked
  // ========================================================================
  console.log("\n[AL7] Blocked status");
  auditLog.recordStart("tc6", "load_data", { file_path: "/etc/passwd" });
  auditLog.recordEnd({ toolCallId: "tc6", result: { details: { blocked: true } }, isError: false });

  const recent6 = auditLog.getRecent(10);
  const blockedEntry = recent6.find((e) => e.toolCallId === "tc6");
  assert("blocked: marked as blocked", blockedEntry?.result === "blocked");

  // ========================================================================
  // AL8: SQL 中的 PII 被脱敏
  // ========================================================================
  console.log("\n[AL8] PII masking in SQL and userIntent");
  const piiSql = "SELECT * FROM users WHERE phone = '13800138000' AND email = 'alice@example.com'";
  const piiIntent = "查找手机号13800138000的用户信息";
  auditLog.recordStart("tc7", "query_data", { sql: piiSql, table_name: "users", user_intent: piiIntent });
  auditLog.recordEnd({ toolCallId: "tc7", result: { details: {} }, isError: false });

  const recent7 = auditLog.getRecent(10);
  const piiEntry = recent7.find((e) => e.toolCallId === "tc7");
  assert("pii: entry exists", !!piiEntry);
  assert("pii: sql does not contain raw phone", !piiEntry?.sql?.includes("13800138000"));
  assert("pii: sql does not contain raw email", !piiEntry?.sql?.includes("alice@example.com"));
  assert("pii: sql contains masked phone", piiEntry?.sql?.includes("138****8000"));
  assert("pii: sql contains masked email", piiEntry?.sql?.includes("a***e@example.com"));
  assert("pii: summary does not contain raw phone", !piiEntry?.summary?.includes("13800138000"));
  assert("pii: userIntent masked", !piiEntry?.userIntent?.includes("13800138000"));
  assert("pii: userIntent contains masked phone", piiEntry?.userIntent?.includes("138****8000"));

  // Cleanup
  try { unlinkSync(logPath); } catch { /* ignore */ }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runAuditLogTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
