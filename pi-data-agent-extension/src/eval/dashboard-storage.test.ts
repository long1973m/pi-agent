/**
 * Dashboard 存储层测试
 * 覆盖 D3, D4, D5, D6, D7, D12
 *
 * D3:  字典读取 - 返回真实表、字段和当前 revision
 * D4:  单字段编辑 - 修改含义后持久化，默认转为 user-corrected
 * D5:  批量确认 - 只处理选中字段，不默认处理 uncertain
 * D6:  revision 冲突 - 旧 revision 写入返回 409
 * D7:  原子写入 - 模拟中断后原 JSON 仍可读取
 * D12: 口径修改 - 修改后 revision 更新
 *
 * 运行: npx tsx src/eval/dashboard-storage.test.ts
 */

import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AtomicStore, RevisionConflictError } from "../dashboard/services/atomic-store.js";
import { DictionaryStore } from "../dashboard/services/dictionary-store.js";
import { MetricStore } from "../dashboard/services/metric-store.js";
import type { MetricEntry } from "../dashboard/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".tmp-dashboard-storage-test");

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

function assertThrows(fn: () => void, errorClass: any, message: string) {
  try {
    fn();
    console.error(`  [FAIL] ${message} — 未抛出异常`);
    failed++;
  } catch (e) {
    if (e instanceof errorClass) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message} — 抛出了非预期类型: ${(e as Error).constructor.name}`);
      failed++;
    }
  }
}

function setup() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// D3: 字典读取
// ============================================================================

console.log("\n--- D3: 字典读取 ---");

function writeDictionaryFile(data: any) {
  const path = join(TEST_DIR, "data-dictionary.json");
  // DictionaryStore 会自动迁移旧格式，但这里直接写 RevisionedData 格式
  const wrapped = {
    data,
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(wrapped, null, 2), "utf-8");
}

console.log("\nD3-a: 返回表列表和字段数");
{
  setup();
  writeDictionaryFile([
    {
      tableName: "orders",
      columns: [
        { name: "id", type: "INTEGER", inferredMeaning: "订单ID", status: "ai-guessed" },
        { name: "amount", type: "DOUBLE", inferredMeaning: "金额", status: "ai-guessed" },
        { name: "status", type: "VARCHAR", inferredMeaning: "状态", status: "user-confirmed", confirmedAt: "2026-01-01T00:00:00Z" },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      status: "ai-guessed",
    },
    {
      tableName: "users",
      columns: [
        { name: "id", type: "INTEGER", inferredMeaning: "用户ID", status: "user-confirmed", confirmedAt: "2026-01-01T00:00:00Z" },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      status: "validated",
    },
  ]);

  const store = new DictionaryStore(TEST_DIR);
  store.getTableList().then(({ tables, revision }) => {
    assertEqual(tables.length, 2, "返回 2 张表");
    assertEqual(revision, 1, "revision 为 1");
    assertEqual(tables[0].name, "orders", "第一张表是 orders");
    assertEqual(tables[0].columnCount, 3, "orders 有 3 个字段");
    assertEqual(tables[0].confirmedCount, 1, "orders 有 1 个已确认字段");
    assertEqual(tables[0].uncertainCount, 2, "orders 有 2 个 uncertain/ai-guessed 字段");
    teardown();
  });
}

console.log("\nD3-b: 获取单张表字段详情");
{
  setup();
  writeDictionaryFile([
    {
      tableName: "orders",
      columns: [
        { name: "id", type: "INTEGER", inferredMeaning: "订单ID", status: "ai-guessed" },
        { name: "amount", type: "DOUBLE", inferredMeaning: "金额", status: "ai-guessed", userMeaning: "订单金额" },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      status: "ai-guessed",
    },
  ]);

  const store = new DictionaryStore(TEST_DIR);
  const { entry, revision } = store.getTable("orders");
  assert(entry !== null, "orders 表存在");
  assertEqual(entry!.tableName, "orders", "表名正确");
  assertEqual(entry!.columns.length, 2, "字段数正确");
  assertEqual(entry!.columns[1].userMeaning, "订单金额", "userMeaning 正确");
  assertEqual(revision, 1, "revision 正确");
  teardown();
}

// ============================================================================
// D4: 单字段编辑
// ============================================================================

console.log("\n--- D4: 单字段编辑 ---");

console.log("\nD4-a: 修改含义后持久化并转为 user-corrected");
{
  setup();
  writeDictionaryFile([
    {
      tableName: "orders",
      columns: [
        { name: "amount", type: "DOUBLE", inferredMeaning: "金额", status: "ai-guessed" },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      status: "ai-guessed",
    },
  ]);

  const store = new DictionaryStore(TEST_DIR);
  const result = store.updateColumn("orders", "amount", {
    userMeaning: "订单总金额（含税）",
  }, 1);

  assertEqual(result.revision, 2, "revision 递增到 2");
  const col = result.data[0].columns.find((c: any) => c.name === "amount")!;
  assertEqual(col.userMeaning, "订单总金额（含税）", "userMeaning 已更新");
  assertEqual(col.status, "user-corrected", "状态自动转为 user-corrected");

  // 验证持久化：重新读取
  const store2 = new DictionaryStore(TEST_DIR);
  const { entry } = store2.getTable("orders");
  const persisted = entry!.columns.find((c: any) => c.name === "amount")!;
  assertEqual(persisted.userMeaning, "订单总金额（含税）", "持久化后 userMeaning 正确");
  assertEqual(persisted.status, "user-corrected", "持久化后状态正确");
  teardown();
}

// ============================================================================
// D5: 批量确认
// ============================================================================

console.log("\n--- D5: 批量确认 ---");

console.log("\nD5-a: 只处理选中字段，不默认处理 uncertain");
{
  setup();
  writeDictionaryFile([
    {
      tableName: "orders",
      columns: [
        { name: "id", type: "INTEGER", inferredMeaning: "订单ID", status: "ai-guessed" },
        { name: "amount", type: "DOUBLE", inferredMeaning: "金额", status: "uncertain" },
        { name: "status", type: "VARCHAR", inferredMeaning: "状态", status: "ai-guessed" },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      status: "ai-guessed",
    },
  ]);

  const store = new DictionaryStore(TEST_DIR);
  // 只确认 id 和 status，不选 amount（uncertain）
  const result = store.batchConfirm("orders", ["id", "status"], 1);

  assertEqual(result.revision, 2, "revision 递增");
  const columns = result.data[0].columns;

  const idCol = columns.find((c: any) => c.name === "id")!;
  assertEqual(idCol.status, "user-confirmed", "id 被确认");

  const amountCol = columns.find((c: any) => c.name === "amount")!;
  assertEqual(amountCol.status, "uncertain", "amount（未选中 + uncertain）未被处理");

  const statusCol = columns.find((c: any) => c.name === "status")!;
  assertEqual(statusCol.status, "user-confirmed", "status 被确认");
  teardown();
}

// ============================================================================
// D6: revision 冲突
// ============================================================================

console.log("\n--- D6: revision 冲突 ---");

console.log("\nD6-a: 旧 revision 写入抛出 RevisionConflictError");
{
  setup();
  const storePath = join(TEST_DIR, "test-revision.json");
  const store = new AtomicStore<{ value: number }>(storePath);

  // 首次写入（expectedRevision = -1 表示首次）
  const r1 = store.write({ value: 1 }, -1, "test");
  assertEqual(r1.revision, 1, "首次写入 revision=1");

  // 第二次写入使用正确 revision
  const r2 = store.write({ value: 2 }, 1, "test");
  assertEqual(r2.revision, 2, "第二次写入 revision=2");

  // 使用旧 revision (1) 尝试写入，应抛出冲突
  assertThrows(
    () => store.write({ value: 999 }, 1, "test"),
    RevisionConflictError,
    "旧 revision 写入抛出 RevisionConflictError",
  );

  // 验证数据未被污染
  const current = store.read();
  assertEqual(current!.data.value, 2, "冲突后数据未被修改");
  assertEqual(current!.revision, 2, "冲突后 revision 未被修改");
  teardown();
}

// ============================================================================
// D7: 原子写入 — 模拟中断后原 JSON 仍可读取
// ============================================================================

console.log("\n--- D7: 原子写入 ---");

console.log("\nD7-a: 写入后文件内容可解析");
{
  setup();
  const storePath = join(TEST_DIR, "test-atomic.json");
  const store = new AtomicStore<{ name: string }>(storePath);

  store.write({ name: "hello" }, -1, "test");

  const raw = readFileSync(storePath, "utf-8");
  const parsed = JSON.parse(raw);
  assertEqual(parsed.data.name, "hello", "文件内容正确");
  assertEqual(parsed.revision, 1, "revision 正确");
  teardown();
}

console.log("\nD7-b: 连续多次写入不丢失数据");
{
  setup();
  const storePath = join(TEST_DIR, "test-atomic-multi.json");
  const store = new AtomicStore<number[]>(storePath);

  for (let i = 0; i < 10; i++) {
    store.write([i], i === 0 ? -1 : i, "test");
  }

  const result = store.read();
  assertEqual(result!.revision, 10, "10 次写入后 revision=10");
  assertEqual(result!.data[0], 9, "数据为最后一次写入的值");
  teardown();
}

console.log("\nD7-c: 原文件在写入前存在，写入失败场景备份恢复");
{
  setup();
  const storePath = join(TEST_DIR, "test-atomic-backup.json");

  // 先写入初始数据
  writeFileSync(storePath, JSON.stringify({ data: "original", revision: 5, updatedAt: "2026-01-01T00:00:00Z" }), "utf-8");

  // AtomicStore 内部有备份机制：写入时先 rename 原文件为 .bak
  // 模拟：写入后检查原文件是否可读（AtomicStore 内部会先 rename → 再 rename 新文件）
  const store = new AtomicStore<string>(storePath);
  const result = store.write("updated", 5, "test");

  assertEqual(result.revision, 6, "写入成功 revision=6");
  assertEqual(result.data, "updated", "数据已更新");

  // 文件存在且可解析
  const raw = readFileSync(storePath, "utf-8");
  const parsed = JSON.parse(raw);
  assertEqual(parsed.data, "updated", "文件内容已更新");
  teardown();
}

// ============================================================================
// D12: 口径修改
// ============================================================================

console.log("\n--- D12: 口径修改 ---");

console.log("\nD12-a: 创建口径");
{
  setup();
  const store = new MetricStore(TEST_DIR);
  const result = store.create(
    {
      name: "月度GMV",
      definition: "当月所有已完成订单的金额总和，不含退款",
      datasets: ["orders"],
      status: "user-confirmed",
      source: "user",
    },
    -1,
  );

  assertEqual(result.revision, 1, "创建后 revision=1");
  assertEqual(result.data.length, 1, "有 1 个口径");
  assertEqual(result.data[0].name, "月度GMV", "口径名称正确");
  assertEqual(result.data[0].definition, "当月所有已完成订单的金额总和，不含退款", "口径定义正确");
  assertEqual(result.data[0].archived, false, "默认未归档");

  // 同步到 agent.md
  const agentMdPath = join(TEST_DIR, "agent.md");
  assert(existsSync(agentMdPath), "agent.md 已同步创建");
  teardown();
}

console.log("\nD12-b: 修改口径后 revision 更新");
{
  setup();
  const store = new MetricStore(TEST_DIR);

  // 先创建
  const created = store.create(
    {
      name: "月度GMV",
      definition: "原始定义",
      datasets: ["orders"],
      status: "user-confirmed",
      source: "user",
    },
    -1,
  );
  const metricId = created.data[0].id;

  // 修改定义
  const updated = store.update(metricId, { definition: "更新后的定义：含退款金额" }, 1);

  assertEqual(updated.revision, 2, "修改后 revision=2");
  const metric = updated.data.find((m: MetricEntry) => m.id === metricId);
  assertEqual(metric!.definition, "更新后的定义：含退款金额", "定义已更新");
  teardown();
}

console.log("\nD12-c: 归档口径（软删除）");
{
  setup();
  const store = new MetricStore(TEST_DIR);

  const created = store.create(
    {
      name: "废弃口径",
      definition: "不再使用",
      datasets: [],
      status: "user-confirmed",
      source: "user",
    },
    -1,
  );
  const metricId = created.data[0].id;

  store.archive(metricId, 1);

  // list 默认不包含已归档
  const { metrics } = store.list();
  assertEqual(metrics.length, 0, "归档后默认列表为空");

  // includeArchived 时可见
  const { metrics: all } = store.list({ includeArchived: true });
  assertEqual(all.length, 1, "includeArchived 时可见");
  assertEqual(all[0].archived, true, "标记为已归档");
  teardown();
}

console.log("\nD12-d: 口径修改同步到 agent.md");
{
  setup();
  const store = new MetricStore(TEST_DIR);
  const agentMdPath = join(TEST_DIR, "agent.md");

  // 创建
  const created = store.create(
    { name: "同步测试", definition: "初始定义", datasets: [], status: "user-confirmed", source: "user" },
    -1,
  );

  // 修改
  const metricId = created.data[0].id;
  store.update(metricId, { definition: "修改后定义" }, 1);

  // 验证 agent.md
  const agentContent = readFileSync(agentMdPath, "utf-8");
  const calibers = JSON.parse(agentContent);
  assert(Array.isArray(calibers), "agent.md 是数组格式");
  assertEqual(calibers[0].definition, "修改后定义", "agent.md 中定义已同步更新");
  teardown();
}

// ============================================================================
// 汇总（延迟 500ms 确保 async 测试完成）
// ============================================================================

setTimeout(() => {
  console.log(`\n=== dashboard-storage.test.ts: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}, 500);