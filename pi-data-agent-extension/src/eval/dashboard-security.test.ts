/**
 * Dashboard 安全测试
 * 覆盖 D13, D14, D15
 *
 * D13: localhost - 非本地 IP 返回 403
 * D14: 写令牌 - 缺失或错误 token 的写请求被拒绝
 * D15: 路径与标识符 - 特殊表名、含特殊字符的标识符不造成路径穿越或 SQL 注入
 *
 * 运行: npx tsx src/eval/dashboard-security.test.ts
 */

import { localOnly } from "../dashboard/middleware/local-only.js";
import { writeTokenGuard, setWriteToken } from "../dashboard/middleware/write-token.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual === expected) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ============================================================================
// Mock 工具
// ============================================================================

/** 构造最小化的 Express Request mock */
function createMockReq(overrides: Record<string, unknown> = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    method: "GET",
    headers: {} as Record<string, unknown>,
    params: {},
    body: {},
    query: {},
    ...overrides,
  };
}

/** 构造最小化的 Express Response mock */
function createMockRes() {
  let _statusCode = 0;
  let _body: unknown = null;
  return {
    status(code: number) {
      _statusCode = code;
      return this;
    },
    json(data: unknown) {
      _body = data;
      return this;
    },
    type(_mime: string) { return this; },
    send(_data: unknown) { return this; },
    get statusCode() { return _statusCode; },
    get body() { return _body; },
  };
}

// ============================================================================
// D13: localhost 中间件
// ============================================================================

console.log("\n--- D13: localhost 限制 ---");

console.log("\nD13-a: 127.0.0.1 放行");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "127.0.0.1" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(nextCalled, "127.0.0.1 调用了 next()");
  assertEqual(res.statusCode, 0, "未设置 status（因为放行了）");
}

console.log("\nD13-b: ::1 放行");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "::1" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(nextCalled, "::1 调用了 next()");
}

console.log("\nD13-c: ::ffff:127.0.0.1 放行");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "::ffff:127.0.0.1" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(nextCalled, "::ffff:127.0.0.1 调用了 next()");
}

console.log("\nD13-d: 192.168.1.100 返回 403");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "192.168.1.100" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(!nextCalled, "192.168.1.100 未调用 next()");
  assertEqual(res.statusCode, 403, "返回 403");
  const body = res.body as any;
  assertEqual(body.error.code, "FORBIDDEN_REMOTE", "错误码为 FORBIDDEN_REMOTE");
}

console.log("\nD13-e: 10.0.0.1 返回 403");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "10.0.0.1" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(!nextCalled, "10.0.0.1 未调用 next()");
  assertEqual(res.statusCode, 403, "返回 403");
}

console.log("\nD13-f: 8.8.8.8（公网 IP）返回 403");
{
  let nextCalled = false;
  const req = createMockReq({ socket: { remoteAddress: "8.8.8.8" } });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  localOnly(req as any, res as any, next);
  assert(!nextCalled, "8.8.8.8 未调用 next()");
  assertEqual(res.statusCode, 403, "返回 403");
}

// ============================================================================
// D14: 写令牌中间件
// ============================================================================

console.log("\n--- D14: 写令牌 ---");

// 设置测试令牌
const TEST_TOKEN = "test-secret-token-12345";

console.log("\nD14-a: GET 请求不需要令牌");
{
  setWriteToken(TEST_TOKEN);
  let nextCalled = false;
  const req = createMockReq({ method: "GET" });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "GET 请求直接放行");
  assertEqual(res.statusCode, 0, "GET 请求未设 status");
}

console.log("\nD14-b: POST 请求携带正确令牌放行");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "POST",
    headers: { "x-write-token": TEST_TOKEN },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "正确令牌的 POST 放行");
}

console.log("\nD14-c: POST 请求缺失令牌返回 403");
{
  let nextCalled = false;
  const req = createMockReq({ method: "POST", headers: {} });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(!nextCalled, "缺失令牌未调用 next()");
  assertEqual(res.statusCode, 403, "返回 403");
  const body = res.body as any;
  assertEqual(body.error.code, "INVALID_WRITE_TOKEN", "错误码为 INVALID_WRITE_TOKEN");
}

console.log("\nD14-d: POST 请求错误令牌返回 403");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "POST",
    headers: { "x-write-token": "wrong-token" },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(!nextCalled, "错误令牌未调用 next()");
  assertEqual(res.statusCode, 403, "返回 403");
}

console.log("\nD14-e: PATCH 请求携带正确令牌放行");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "PATCH",
    headers: { "x-write-token": TEST_TOKEN },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "正确令牌的 PATCH 放行");
}

console.log("\nD14-f: DELETE 请求携带正确令牌放行");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "DELETE",
    headers: { "x-write-token": TEST_TOKEN },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "正确令牌的 DELETE 放行");
}

console.log("\nD14-g: PUT 请求携带正确令牌放行");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "PUT",
    headers: { "x-write-token": TEST_TOKEN },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "正确令牌的 PUT 放行");
}

console.log("\nD14-h: Bearer token 格式支持");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "POST",
    headers: { "authorization": `Bearer ${TEST_TOKEN}` },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "Bearer token 格式放行");
}

console.log("\nD14-i: x-write-token 优先于 authorization");
{
  let nextCalled = false;
  const req = createMockReq({
    method: "POST",
    headers: {
      "x-write-token": TEST_TOKEN,
      "authorization": "Bearer wrong-token",
    },
  });
  const res = createMockRes();
  const next = () => { nextCalled = true; };

  writeTokenGuard(req as any, res as any, next);
  assert(nextCalled, "x-write-token 优先于 authorization");
}

// ============================================================================
// D15: 路径与标识符校验
// ============================================================================

console.log("\n--- D15: 路径与标识符校验 ---");

// 路由中使用的校验正则
const IDENTIFIER_REGEX = /^[\w-]+$/;

console.log("\nD15-a: 正常表名/ID 通过校验");
{
  assert(IDENTIFIER_REGEX.test("orders"), "orders 通过");
  assert(IDENTIFIER_REGEX.test("my_table"), "my_table 通过");
  assert(IDENTIFIER_REGEX.test("my-table"), "my-table 通过");
  assert(IDENTIFIER_REGEX.test("Table1"), "Table1 通过");
  assert(IDENTIFIER_REGEX.test("_private"), "_private 通过");
  assert(IDENTIFIER_REGEX.test("session-1704153600000"), "session-1704153600000 通过");
  assert(IDENTIFIER_REGEX.test("metric_abc123"), "metric_abc123 通过");
}

console.log("\nD15-b: 路径穿越攻击被拦截");
{
  assert(!IDENTIFIER_REGEX.test("../etc/passwd"), "../etc/passwd 被拒绝");
  assert(!IDENTIFIER_REGEX.test("..\\windows\\system32"), "..\\windows\\system32 被拒绝");
  assert(!IDENTIFIER_REGEX.test("foo/../../../bar"), "foo/../../../bar 被拒绝");
  assert(!IDENTIFIER_REGEX.test("./local"), "./local 被拒绝");
  assert(!IDENTIFIER_REGEX.test("/absolute/path"), "/absolute/path 被拒绝");
}

console.log("\nD15-c: SQL 注入模式被拦截");
{
  assert(!IDENTIFIER_REGEX.test("table; DROP TABLE users--"), "SQL 注入被拒绝");
  assert(!IDENTIFIER_REGEX.test("1; SELECT * FROM users"), "SQL 注入被拒绝");
  assert(!IDENTIFIER_REGEX.test("' OR '1'='1"), "SQL 注入被拒绝");
  assert(!IDENTIFIER_REGEX.test("table UNION SELECT"), "UNION 注入被拒绝");
  assert(!IDENTIFIER_REGEX.test("table/**/OR"), "注释注入被拒绝");
}

console.log("\nD15-d: 特殊字符被拦截");
{
  assert(!IDENTIFIER_REGEX.test("table name"), "空格被拒绝");
  assert(!IDENTIFIER_REGEX.test("table.name"), "点号被拒绝");
  assert(!IDENTIFIER_REGEX.test("table,name"), "逗号被拒绝");
  assert(!IDENTIFIER_REGEX.test("table;name"), "分号被拒绝");
  assert(!IDENTIFIER_REGEX.test("table<name"), "尖括号被拒绝");
  assert(!IDENTIFIER_REGEX.test("table&name"), "& 符号被拒绝");
  assert(!IDENTIFIER_REGEX.test("table(name)"), "括号被拒绝");
  assert(!IDENTIFIER_REGEX.test(""), "空字符串被拒绝");
}

console.log("\nD15-e: Unicode / 中文被拦截");
{
  assert(!IDENTIFIER_REGEX.test("订单表"), "中文表名被拒绝");
  assert(!IDENTIFIER_REGEX.test("table\u0000"), "null 字节被拒绝");
  assert(!IDENTIFIER_REGEX.test("table\n"), "换行符被拒绝");
}

// ============================================================================
// 汇总
// ============================================================================

console.log(`\n=== dashboard-security.test.ts: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);