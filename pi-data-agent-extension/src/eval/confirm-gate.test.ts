import { describe, it, expect } from "vitest";
import { resolveConfirmGate, SecurityChecker } from "../security.js";
import type { SecurityConfig } from "../types.js";

describe("resolveConfirmGate（v0.11 S-1 fail-closed）", () => {
  it("autoConfirmWrite=true 时放行并标记 auto-confirmed", () => {
    const gate = resolveConfirmGate("modify data?", {
      autoConfirmWrite: true,
      hasUi: false,
    });
    expect(gate).toEqual({ action: "allow", autoConfirmed: true });
  });

  it("有交互 UI 时维持 confirm 行为", () => {
    const gate = resolveConfirmGate("modify data?", {
      autoConfirmWrite: false,
      hasUi: true,
    });
    expect(gate).toEqual({ action: "confirm", confirmMessage: "modify data?" });
  });

  it("无 UI 且未配置 autoConfirmWrite 时必须 block（fail-closed）", () => {
    const gate = resolveConfirmGate("modify data?", {
      autoConfirmWrite: false,
      hasUi: false,
    });
    expect(gate.action).toBe("block");
    if (gate.action === "block") {
      expect(gate.reason).toContain("PI_DATA_AGENT_AUTO_CONFIRM_WRITE=true");
    }
  });

  it("autoConfirmWrite 优先级高于 hasUi（显式配置即放行）", () => {
    const gate = resolveConfirmGate("modify data?", {
      autoConfirmWrite: true,
      hasUi: true,
    });
    expect(gate).toEqual({ action: "allow", autoConfirmed: true });
  });
});

describe("确认门集成：headless 环境写 SQL 必须被拦截", () => {
  const mockConfig: SecurityConfig = {
    cwd: "/test",
    allowedPaths: ["/test"],
    autoConfirmWrite: false,
    dangerousSqlPatterns: [],
    blockOutOfBoundsPath: true,
  };
  const checker = new SecurityChecker(mockConfig);

  it("UPDATE 在无 UI 环境下经确认门判定后应得到 block", () => {
    const check = checker.checkSql("UPDATE users SET name = 'x' WHERE id = 1");
    expect(check.action).toBe("confirm");
    if (check.action === "confirm") {
      const gate = resolveConfirmGate(check.confirmMessage!, {
        autoConfirmWrite: false,
        hasUi: false,
      });
      expect(gate.action).toBe("block");
    }
  });

  it("CTE 夹带写操作在无 UI 环境下同样被 block", () => {
    const check = checker.checkSql(
      "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"
    );
    expect(check.action).toBe("confirm");
    if (check.action === "confirm") {
      const gate = resolveConfirmGate(check.confirmMessage!, {
        autoConfirmWrite: false,
        hasUi: false,
      });
      expect(gate.action).toBe("block");
    }
  });

  it("SELECT 只读查询不经过确认门，直接放行", () => {
    expect(checker.checkSql("SELECT * FROM users").action).toBe("allow");
  });
});
