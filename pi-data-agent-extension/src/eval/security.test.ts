import { describe, it, expect } from "vitest";
import { SecurityChecker } from "../security.js";
import type { SecurityConfig } from "../types.js";

describe("SecurityChecker", () => {
  const mockConfig: SecurityConfig = {
    cwd: "/test",
    allowedPaths: ["/test"],
    autoConfirmWrite: false,
    dangerousSqlPatterns: [
      /^\s*DROP\s+TABLE\s+\w+\s*;?\s*$/i,
      /^\s*DELETE\s+FROM\s+\w+\s*;?\s*$/i,
    ],
    blockOutOfBoundsPath: true,
  };
  const checker = new SecurityChecker(mockConfig);

  describe("SQL分类检测", () => {
    it("正常SELECT应该识别为read", () => {
      expect(checker.classifySql("SELECT * FROM users")).toBe("read");
      expect(checker.classifySql("  SELECT id, name FROM orders WHERE id = 1")).toBe("read");
      expect(checker.classifySql("WITH temp AS (SELECT 1) SELECT * FROM temp")).toBe("read");
    });

    it("INSERT/UPDATE/DELETE应该识别为write", () => {
      expect(checker.classifySql("INSERT INTO users VALUES (1, 'test')")).toBe("write");
      expect(checker.classifySql("UPDATE users SET name = 'test' WHERE id = 1")).toBe("write");
      expect(checker.classifySql("DELETE FROM users WHERE id = 1")).toBe("write");
      expect(checker.classifySql("CREATE TABLE IF NOT EXISTS users (id INT)")).toBe("write");
    });

    it("DROP/TRUNCATE应该识别为dangerous", () => {
      expect(checker.classifySql("DROP TABLE users")).toBe("dangerous");
      expect(checker.classifySql("TRUNCATE TABLE users")).toBe("dangerous");
      expect(checker.classifySql("ALTER USER test SET password = '123'")).toBe("dangerous");
    });

    it("带注释的SQL应该正确检测", () => {
      expect(checker.classifySql("-- 删除表\nDROP TABLE test")).toBe("dangerous");
      expect(checker.classifySql("/* 这是注释 */ DELETE FROM test")).toBe("write");
      expect(checker.classifySql("SELECT * FROM users -- 查询用户")).toBe("read");
    });

    it("CTE中的写操作应该正确识别", () => {
      expect(checker.classifySql(`
        WITH temp AS (
          SELECT id FROM users WHERE age > 18
        )
        DELETE FROM users WHERE id IN (SELECT id FROM temp)
      `)).toBe("write");
      expect(checker.classifySql(`
        WITH temp AS (SELECT 1)
        INSERT INTO test SELECT * FROM temp
      `)).toBe("write");
    });
  });
});
