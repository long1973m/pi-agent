import { describe, it, expect } from "vitest";
import { SecurityChecker } from "../security.js";
import type { SecurityConfig } from "../types.js";

function makeChecker(allowedPaths: string[]): SecurityChecker {
  const config: SecurityConfig = {
    cwd: allowedPaths[0],
    allowedPaths,
    autoConfirmWrite: false,
    dangerousSqlPatterns: [],
    blockOutOfBoundsPath: true,
  };
  return new SecurityChecker(config);
}

describe("SQL 内嵌文件路径白名单（v0.11 S-2）", () => {
  const dir = "/tmp/pi-s2-test";
  const checker = makeChecker([dir]);

  it("read_csv 越界绝对路径被 block", () => {
    const r = checker.checkSql("SELECT * FROM read_csv('/etc/passwd')");
    expect(r.action).toBe("block");
    expect(r.reason).toContain("/etc/passwd");
  });

  it("read_csv 白名单内路径放行", () => {
    expect(checker.checkSql(`SELECT * FROM read_csv('${dir}/data.csv')`).action).toBe("allow");
  });

  it("read_parquet / read_text / parquet_scan 越界被 block", () => {
    expect(checker.checkSql("SELECT * FROM read_parquet('/x/a.parquet')").action).toBe("block");
    expect(checker.checkSql("SELECT count(*) FROM read_text('/etc/hosts')").action).toBe("block");
    expect(checker.checkSql("SELECT * FROM parquet_scan('/x/b.parquet')").action).toBe("block");
  });

  it("COPY TO 越界目标被 block，白名单内放行", () => {
    expect(checker.checkSql("COPY (SELECT 1) TO '/etc/evil.csv' (HEADER)").action).toBe("block");
    expect(checker.checkSql(`COPY (SELECT 1) TO '${dir}/out.csv' (HEADER)`).action).not.toBe("block");
  });

  it("FROM '文件' 简写越界被 block", () => {
    expect(checker.checkSql("SELECT * FROM '/etc/passwd'").action).toBe("block");
  });

  it("注释中的路径不参与检查", () => {
    expect(checker.checkSql("-- read_csv('/etc/x')\nSELECT 1").action).toBe("allow");
  });

  it("字符串字面量中的普通文本不触发路径检查", () => {
    expect(
      checker.checkSql(`SELECT * FROM logs WHERE note = 'see read_csv manual'`)
    ).not.toBe("block");
  });
});

describe("classifySql 字面量剥离（v0.11 S-2b）", () => {
  const checker = makeChecker(["/tmp"]);

  it("字面量中的 DROP 不再误判为 dangerous", () => {
    expect(
      checker.classifySql(`SELECT * FROM logs WHERE action = 'DROP TABLE users'`)
    ).toBe("read");
  });

  it("字面量中的 grant/update 文本不再误判为写操作", () => {
    expect(
      checker.classifySql(`SELECT id FROM t WHERE note LIKE '%grant access%' OR note = 'updated at noon'`)
    ).toBe("read");
  });

  it("真实写操作仍正确识别（剥离不影响关键词检测）", () => {
    expect(checker.classifySql("UPDATE t SET note = 'DROP TABLE x' WHERE id = 1")).toBe("write");
    expect(checker.classifySql("INSERT INTO t VALUES ('test')")).toBe("write");
    expect(checker.classifySql("TRUNCATE TABLE t")).toBe("dangerous");
  });

  it("CTE 夹带写操作仍识别为 write（回归保护）", () => {
    expect(
      checker.classifySql("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x")
    ).toBe("write");
  });
});
