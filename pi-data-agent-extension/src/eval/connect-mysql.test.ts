/**
 * v0.12 T-1 — MySQL 只读连接（阶段 1）验收测试
 *
 * 运行: npx vitest run（经 defineScriptSuite 纳入统一回归）
 *
 * 无真库策略（spec §0.1）：127.0.0.1:1 是确定不通的端口，
 * 足以验证连接失败路径、异常脱敏、白名单内外——§0.1 已实测该路径
 * 错误形态与调研 CLI 实测一致（secret 路径错误文本不含密码）。
 *
 * 覆盖:
 * - CM1:  默认配置（白名单空）任何 host block
 * - CM2:  白名单内 host:port 放行到连接阶段（失败发生在网络层而非安全层）
 * - CM3:  白名单条目 host 匹配但端口不符 → block
 * - CM4:  localhost 与 127.0.0.1 不互通
 * - CM5:  无凭据 headless → block，文案含三种配置方式
 * - CM6:  MYSQL_PWD env 提供后走到 ATTACH，连接失败返回
 * - CM7:  失败返回体 JSON.stringify 后 grep 密码原文零命中
 * - CM8:  ATTACH/DETACH 语句经 checkSql 一律 blocked（含 autoConfirmWrite=true 仍 block）
 * - CM9:  secret 失败无残留：两次连续连接同名 alias 不冲突
 * - CM10: 参数 schema 不含 password 字段（结构断言）
 * - CM11: redactCredentials 明文 ATTACH 错误样本脱敏（M-6 验收）
 * - CM12: audit-log 落盘内容不含密码（M-6 验收）
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker, redactCredentials } from "../security.js";
import { AuditLogManager } from "../audit-log.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createConnectDatabaseTool } from "../tools/connect-database.js";
import type { ToolContext } from "../tools/tool-context.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const PASSWORD = "sup3rsecret_v012_test";
const DEAD_HOST = "127.0.0.1";
const DEAD_PORT = 1; // 确定不通的端口

// 独立临时目录，避免污染项目 .pi-data-agent
const TEST_DIR = mkdtempSync(join(tmpdir(), "pi-agent-mysql-test-"));

function makeTool(opts?: { dbAllowedHosts?: string[]; autoConfirmWrite?: boolean }) {
  const base = toSecurityConfig(loadConfig({ cwd: TEST_DIR }));
  const security = new SecurityChecker({
    ...base,
    autoConfirmWrite: opts?.autoConfirmWrite ?? false,
    dbAllowedHosts: opts?.dbAllowedHosts ?? [],
  });
  const engine = new DuckDBEngine({
    dbPath: join(TEST_DIR, "session.duckdb"),
    previewLimit: 100,
    outputDir: join(TEST_DIR, "output"),
  });
  const persistence = new PersistenceManager(
    join(TEST_DIR, "global"),
    join(TEST_DIR, "project")
  );
  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: TEST_DIR,
    config: loadConfig({ cwd: TEST_DIR }),
    dataDictionary: {} as any,
    queryMemory: {} as any,
  };
  const tool = createConnectDatabaseTool({ getRuntime: () => toolContext });
  // headless ctx：ui 为 null（M-5 凭据解析第 3 级在此环境不可用）
  const ctx = { ui: null, cwd: TEST_DIR } as any;
  return { engine, security, tool, ctx };
}

/** DuckDB 单连接约束：每个用例结束必须关闭引擎，否则下一个 DuckDBInstance 拿不到文件锁 */
let currentEngine: DuckDBEngine | null = null;

async function makeInitializedTool(opts?: { dbAllowedHosts?: string[]; autoConfirmWrite?: boolean }) {
  const parts = makeTool(opts);
  await parts.engine.init();
  // 引擎 home_directory 指向临时目录会让 INSTALL 重新联网下载扩展；
  // 复用本机 ~/.duckdb/extensions 缓存，测试无需外网
  const extDir = join(homedir(), ".duckdb", "extensions");
  if (existsSync(extDir)) {
    try {
      await parts.engine.exec(`SET extension_directory = '${extDir.replace(/'/g, "''")}'`);
    } catch { /* 缓存不可用时按联网路径走 */ }
  }
  currentEngine = parts.engine;
  return parts;
}

describe("v0.12 T-1: connect_database mysql 分支", () => {
  beforeEach(() => {
    vi.stubEnv("MYSQL_PWD", "");
    vi.stubEnv("PI_DATA_AGENT_MYSQL_PWD", "");
  });
  afterEach(async () => {
    if (currentEngine) {
      await currentEngine.close();
      currentEngine = null;
    }
    vi.unstubAllEnvs();
  });
  afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // CM1: 默认配置（白名单空）任何 host block
  it("CM1: default empty whitelist blocks any host with guidance", async () => {
    const { security } = makeTool();
    const r = security.checkRemoteTarget(DEAD_HOST, 3306);
    expect(r.action).toBe("block");
    expect(r.reason).toContain("PI_DATA_AGENT_DB_ALLOWED_HOSTS");
    expect(r.reason).toContain("dbAllowedHosts");
  });

  // CM3: 白名单条目 host 匹配但端口不符 → block
  it("CM3: host matches but port mismatch blocks", async () => {
    const { security } = makeTool({ dbAllowedHosts: ["127.0.0.1:3306"] });
    const r = security.checkRemoteTarget(DEAD_HOST, 9999);
    expect(r.action).toBe("block");
  });

  // CM4: localhost 与 127.0.0.1 不互通（写哪条算哪条，避免隐式扩权）
  it("CM4: localhost and 127.0.0.1 are NOT equivalent", async () => {
    const { security } = makeTool({ dbAllowedHosts: ["localhost"] });
    expect(security.checkRemoteTarget("LOCALHOST", 3306).action).toBe("allow"); // 大小写归一化
    expect(security.checkRemoteTarget("127.0.0.1", 3306).action).toBe("block");
  });

  // CM2 + CM6 + CM7 + CM9: 白名单放行后走完凭据 → ATTACH 失败路径
  it("CM2/6/7/9: whitelisted dead endpoint proceeds to attach and fails without leaking password; alias reusable", async () => {
    const { tool, ctx } = await makeInitializedTool({ dbAllowedHosts: [`${DEAD_HOST}:${DEAD_PORT}`] });
    process.env.MYSQL_PWD = PASSWORD;

    const args = {
      db_type: "mysql",
      host: DEAD_HOST,
      port: DEAD_PORT,
      user: "testuser",
      database: "testdb",
      alias: "mysql_verify",
    };

    // 第一次连接：白名单放行 → 凭据存在 → ATTACH 失败（网络层）
    const r1 = await tool.execute("t1", args, undefined, undefined, ctx);
    const d1 = r1.details as any;
    expect(d1.blocked).toBeUndefined(); // 未被安全层拦截（CM2）
    expect(d1.error).toMatch(/Failed to connect to MySQL database with parameters/);
    const secrets = await currentEngine!.query("SELECT name FROM duckdb_secrets() WHERE name = 'pi_data_agent_mysql_mysql_verify'");
    expect(secrets.rows).toHaveLength(0);

    // CM7: 返回体整体 grep 密码原文零命中
    const serialized = JSON.stringify(r1);
    expect(serialized.includes(PASSWORD)).toBe(false);

    // CM9: secret 失败无残留——第二次同名 alias 连接报同样的连接错误，而非 alias/secret 冲突
    const r2 = await tool.execute("t2", args, undefined, undefined, ctx);
    const d2 = r2.details as any;
    expect(d2.error).toBeTruthy();
    expect(d2.error).not.toContain("already attached");
    expect(d2.error).not.toContain("already exists");
    expect(String(d2.error)).not.toContain(PASSWORD);
  });

  // CM5: 无凭据 headless → block，文案含三种配置方式
  it("CM5: no credentials in headless blocks with three config options", async () => {
    const { tool, ctx } = await makeInitializedTool({ dbAllowedHosts: [`${DEAD_HOST}:${DEAD_PORT}`] });
    const r = await tool.execute(
      "t5",
      { db_type: "mysql", host: DEAD_HOST, port: DEAD_PORT, user: "u", database: "d" },
      undefined, undefined, ctx
    );
    const d = r.details as any;
    expect(d.blocked).toBe(true);
    expect(d.error).toBe("no_credentials");
    const text = (r.content as any)[0].text;
    expect(text).toContain("PI_DATA_AGENT_MYSQL_PWD");
    expect(text).toContain("MYSQL_PWD");
    expect(text).toContain("interactive");
  });

  // CM8: ATTACH/DETACH 语句经 checkSql 一律 blocked（autoConfirmWrite=true 仍 block）
  it("CM8: ATTACH/DETACH via checkSql always blocked, autoConfirmWrite does NOT exempt", () => {
    const { security } = makeTool({ autoConfirmWrite: true, dbAllowedHosts: [`${DEAD_HOST}:3306`] });
    const samples = [
      "ATTACH 'host=x password=y' AS y (TYPE MYSQL)",
      "attach 'host=x' as y (TYPE MYSQL)",
      "SELECT 1;\nATTACH 'host=x' AS y (TYPE MYSQL)", // 多行夹带
      "/* c */ ATTACH 'host=x' AS y", // 注释夹带
      "DETACH DATABASE x",
      // 字面量里的 attach 不应误报（反向验证）
    ];
    for (const sql of samples) {
      const r = security.checkSql(sql);
      expect(r.action).toBe("block");
    }
    // 反向验证：字面量中的 'attach' 不触发（剥离字面量后匹配骨架）
    const benign = security.checkSql("SELECT * FROM t WHERE note = 'please attach this file'");
    expect(benign.action).toBe("allow");
  });

  // CM10: 参数 schema 不含 password 字段（结构断言）
  it("CM10: tool parameter schema contains no password field", () => {
    const { tool } = makeTool();
    const schema = JSON.stringify(tool.parameters);
    expect(schema.toLowerCase().includes("password")).toBe(false);
  });

  // CM11: redactCredentials 对明文 ATTACH 错误样本脱敏（M-6 验收）
  it("CM11: redactCredentials strips password from plaintext attach error sample", () => {
    const sample =
      "IO Error: Failed to connect: ATTACH 'host=db.internal port=3306 user=u password=supersecret' failed";
    const redacted = redactCredentials(sample);
    expect(redacted.includes("supersecret")).toBe(false);
    expect(redacted).toContain("password=***");
    // PWD / IDENTIFIED BY 变体
    expect(redactCredentials("connect with PWD abc123 failed").includes("abc123")).toBe(false);
    expect(redactCredentials("CREATE USER u IDENTIFIED BY 'p@ss'").includes("p@ss")).toBe(false);
  });

  // CM12: audit-log 落盘内容不含密码（M-6 验收）
  it("CM12: audit log persisted file contains no password", () => {
    const manager = new AuditLogManager(TEST_DIR);
    const callId = "audit-cm12";
    manager.recordStart(callId, "query_data", {
      sql: `ATTACH 'host=x password=${PASSWORD}' AS y`,
    });
    manager.recordEnd({
      toolCallId: callId,
      isError: true,
      result: { details: { error: `failed: password=${PASSWORD}` } },
    });
    const raw = readFileSync(join(TEST_DIR, "audit.log"), "utf-8");
    expect(raw.includes(PASSWORD)).toBe(false);
  });
});
