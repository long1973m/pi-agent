#!/bin/bash
# ==============================================================================
# Pi Data Agent Extension v0.2 — 人工验收脚本
#
# 用途：按步骤验证 v0.2 交付物是否满足 Spec 要求
# 运行：bash acceptance-v2.sh
# 前提：cd pi-data-agent-extension && npm install 已完成
#
# 验收项（10 项）:
#   4.2.1  加载 iris.csv
#   4.2.2  查询各品种数量
#   4.2.3  生成柱状图 (visualize)
#   4.2.4  展示图表或返回 PNG 路径 (show_image)
#   4.2.5  "分析一下这些数据" → 主动反问触发
#   4.2.6  确认口径 → agent.md 写入
#   4.2.7  同一口径再问 → 不重复反问
#   4.2.8  故意错误 SQL → 失败查询入库
#   4.2.9  修改表结构 → 旧查询 outdated
#   4.2.10 v0.1 主流程重新跑 → 未退化
# ==============================================================================

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================================"
echo " Pi Data Agent Extension v0.2 — 人工验收脚本"
echo " 日期: $(date +%Y-%m-%d)"
echo "================================================================"

# ==============================================================================
# Step 0: 环境检查
# ==============================================================================
echo ""
echo "[Step 0] 环境检查"

command -v node &>/dev/null && pass "Node.js: $(node --version)" || fail "Node.js 未安装"
command -v python3 &>/dev/null && pass "Python3: $(python3 --version)" || fail "Python3 未安装（visualize 工具需要）"
command -v npx &>/dev/null && pass "npx 可用" || fail "npx 不可用"

# 检查 Python 依赖
if python3 -c "import matplotlib, pandas, seaborn" 2>/dev/null; then
  pass "Python 依赖: matplotlib + pandas + seaborn 可用"
else
  fail "Python 依赖缺失: matplotlib / pandas / seaborn（pip install --break-system-packages matplotlib pandas seaborn）"
fi

# 检查 npm 包
[ -f "node_modules/@duckdb/node-api/package.json" ] && pass "DuckDB 已安装" || fail "DuckDB 未安装"
[ -f "node_modules/@earendil-works/pi-coding-agent/package.json" ] && pass "Pi SDK 已安装" || fail "Pi SDK 未安装"

# ==============================================================================
# Step 1: TypeScript 编译 + 构建
# ==============================================================================
echo ""
echo "[Step 1] 编译 + 构建"

COMPILE_OUTPUT=$(npm run check 2>&1) && pass "npm run check 零错误" || fail "npm run check 有编译错误"

npm run build 2>&1 >/dev/null
[ -f "dist/index.js" ] && pass "npm run build 成功" || fail "npm run build 失败"

# ==============================================================================
# Step 2: v0.2 文件完整性
# ==============================================================================
echo ""
echo "[Step 2] v0.2 新增文件完整性"

V2_FILES=(
  "src/tools/visualize.ts"
  "src/tools/show-image.ts"
  "src/engine/python-stateless.ts"
  "scripts/generate_chart.py"
  "skills/visualization/SKILL.md"
  "skills/visualization/scripts/chart-templates.sql"
)

for f in "${V2_FILES[@]}"; do
  [ -f "$f" ] && pass "  $f 存在" || fail "  $f 缺失"
done

# ==============================================================================
# 4.2.1 ~ 4.2.7: 端到端工具测试
# ==============================================================================
echo ""
echo "[Step 3] v0.2 端到端工具测试"

# 生成临时测试脚本（内联 TS，避免创建临时文件时路径问题）
cat > .v2-acceptance-temp.ts << 'EOF'
import { loadConfig, toSecurityConfig } from './src/config.js';
import { PersistenceManager } from './src/persistence.js';
import { SecurityChecker } from './src/security.js';
import { DuckDBEngine } from './src/engine/duckdb.js';
import { DataDictionaryManager } from './src/hooks/data-dictionary.js';
import { QueryMemoryManager, classifyError } from './src/hooks/query-memory.js';
import { detectAmbiguity } from './src/hooks/active-questioning.js';
import { createLoadDataTool } from './src/tools/load-data.js';
import { createQueryDataTool } from './src/tools/query-data.js';
import { createVisualizeTool } from './src/tools/visualize.js';
import { createShowImageTool } from './src/tools/show-image.js';
import { createAskClarificationTool } from './src/tools/ask-clarification.js';
import type { ToolContext } from './src/tools/tool-context.js';
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, '.pi-data-agent', 'eval-v2');

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`PASS|${name}`); passed++; }
  else { console.log(`FAIL|${name}${detail ? '|'+detail : ''}`); failed++; }
}

const mockCtx = { ui: null, cwd: TEST_CWD, sessionManager: { getBranch: () => [], appendEntry: () => {} } } as any;

async function main() {
  mkdirSync(EVAL_DIR, { recursive: true });

  // 创建 iris.csv
  const irisCsv = `sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
4.7,3.2,1.3,0.2,setosa
7.0,3.2,4.7,1.4,versicolor
6.4,3.2,4.5,1.5,versicolor
6.9,3.1,4.9,1.5,versicolor
6.3,3.3,6.0,2.5,virginica
5.8,2.7,5.1,1.9,virginica
7.1,3.0,5.9,2.1,virginica
`;
  const irisPath = join(EVAL_DIR, 'iris.csv');
  writeFileSync(irisPath, irisCsv);

  const config = loadConfig();
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], 'project');
  persistence.saveQueryMemory({ maxEntries: 10, entries: [] }, 'project');

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({ dbPath: config.dbPath, previewLimit: config.previewLimit, outputDir: config.outputDir });
  await engine.init();

  const dataDict = new DataDictionaryManager(persistence);
  const queryMemory = new QueryMemoryManager(persistence);

  const toolContext: ToolContext = { engine, security, persistence, cwd: config.cwd, config, dataDictionary: dataDict, queryMemory, dataDictionaryManager: dataDict, queryMemoryManager: queryMemory } as any;
  const getRuntime = () => toolContext;

  const loadTool = createLoadDataTool({ getRuntime });
  const queryTool = createQueryDataTool({ getRuntime });
  const vizTool = createVisualizeTool({ getRuntime });
  const showImgTool = createShowImageTool({ getRuntime });
  const askTool = createAskClarificationTool({ getRuntime });

  // ========== 4.2.1 加载 iris.csv ==========
  const loadResult = await loadTool.execute('t', { file_path: irisPath, table_name: 'iris' }, undefined, undefined, mockCtx);
  assert('4.2.1 load iris.csv', (loadResult.details as any)?.tableName === 'iris');

  // 设置初始 schema fingerprint
  await dataDict.ensureDictionary('iris', engine);
  const initFp = dataDict.getDictionary('iris')?.schemaFingerprint ?? '';
  queryMemory.setDatasetFingerprint(initFp);

  // ========== 4.2.2 查询各品种数量 ==========
  const queryResult = await queryTool.execute('t', {
    sql: 'SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species',
    user_intent: '查询各品种数量',
    table_name: 'iris',
  }, undefined, undefined, mockCtx);
  assert('4.2.2 query species count', (queryResult.details as any)?.totalRowCount === 3);

  // ========== 4.2.3 生成柱状图 ==========
  const vizResult = await vizTool.execute('t', {
    sql: 'SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species',
    chart_type: 'bar',
    x_column: 'species',
    y_column: 'cnt',
    title: 'Species Count',
  }, undefined, undefined, mockCtx);
  const vizPng = (vizResult.details as any)?.pngPath as string | undefined;
  assert('4.2.3 generate bar chart', vizPng ? existsSync(vizPng) && statSync(vizPng).size > 0 : false);

  // ========== 4.2.4 展示图表 ==========
  if (vizPng) {
    const showResult = await showImgTool.execute('t', { file_path: vizPng }, undefined, undefined, mockCtx);
    const hasImage = (showResult.content as any[]).some((c: any) => c.type === 'image');
    assert('4.2.4 show_image returns image', hasImage);
  } else {
    assert('4.2.4 show_image returns image (skip - no png)', false, 'vizPng not generated');
  }

  // ========== 4.2.5 "分析一下这些数据" → 主动反问触发 ==========
  const ambiguous = detectAmbiguity('分析一下这些数据', 'iris');
  assert('4.2.5 ambiguous triggers clarification', ambiguous.isAmbiguous === true);

  // ========== 4.2.6 确认口径 → agent.md 写入 ==========
  await askTool.execute('t', {
    question: '你想分析哪个维度的数据？',
    why: '数据集包含多个维度',
    options: [
      { id: 'length', label: '花萼/花瓣长度', implied_assumption: '用户想分析长度数据' },
      { id: 'count', label: '品种数量', implied_assumption: '用户想分析数量' },
    ],
    default_if_skip: 'length',
  }, undefined, undefined, mockCtx);

  const agentMdPath = join(config.projectConfigDir, 'agent.md');
  const hasCaliber = existsSync(agentMdPath);
  assert('4.2.6 caliber written to agent.md', hasCaliber);

  // ========== 4.2.7 同一口径再问 → 不重复反问 ==========
  const hasCal = hasCaliber ? persistence.hasCaliberForQuestion('你想分析哪个维度的数据？') : false;
  assert('4.2.7 same question not re-asked', hasCal);

  // ========== 4.2.8 故意错误 SQL → 失败查询入库 ==========
  // 直接用 error-recovery 机制（需要触发 SQL 执行失败）
  const badQueryResult = await queryTool.execute('t', {
    sql: 'SELECT * FROM nonexistent_table_xyz',
    user_intent: '查询不存在的表',
  }, undefined, undefined, mockCtx);
  const failedQueries = queryMemory.getFailedQueries();
  const hasFailed = failedQueries.some((e) => e.failureCategory === 'not_found');
  assert('4.2.8 failed query recorded', hasFailed);

  // ========== 4.2.9 修改表结构 → 旧查询 outdated ==========
  await engine.exec('ALTER TABLE iris ADD COLUMN extra_col INTEGER DEFAULT 0');
  await dataDict.refreshFingerprint('iris', engine);
  const newFp = dataDict.getDictionary('iris')?.schemaFingerprint ?? '';
  queryMemory.setDatasetFingerprint(newFp);

  const relevant = queryMemory.recallRelevantQueries(3);
  // 旧查询的 fingerprint 不匹配，不应被召回
  const oldQueryRecalled = relevant.some((e) => e.sql.includes('species'));
  assert('4.2.9 stale query not recalled', !oldQueryRecalled);

  const promptInjection = queryMemory.generatePromptInjection();
  assert('4.2.9 prompt shows schema change', promptInjection.includes('Schema Change Detected'));

  // Cleanup
  await engine.close();
  try { unlinkSync(irisPath); } catch {}
  if (agentMdPath && hasCaliber) { try { unlinkSync(agentMdPath); } catch {} }

  console.log(`SUMMARY|${passed}|${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL|' + err.message);
  process.exit(1);
});
EOF

echo ""
echo "[Step 3] 运行 v0.2 端到端测试"
V2_OUTPUT=$(npx tsx .v2-acceptance-temp.ts 2>&1) || true
rm -f .v2-acceptance-temp.ts

# 逐项解析
V2_PASS=0
V2_FAIL=0
while IFS='|' read -r STATUS NAME DETAIL; do
  case "$STATUS" in
    PASS) pass "  $NAME"; V2_PASS=$((V2_PASS + 1)) ;;
    FAIL) fail "  $NAME ($DETAIL)"; V2_FAIL=$((V2_FAIL + 1)) ;;
    SUMMARY)
      echo "  --- v0.2 端到端: $NAME passed, $DETAIL failed ---"
      ;;
    FATAL)
      fail "  运行时错误: $NAME"
      ;;
  esac
done <<< "$V2_OUTPUT"

# ==============================================================================
# 4.2.10: v0.1 回归
# ==============================================================================
echo ""
echo "[Step 4] v0.1 回归测试"

REG_OUTPUT=$(npx tsx src/eval/regression.test.ts 2>&1) || true
REG_PASS=$(echo "$REG_OUTPUT" | grep -o 'Passed: *[0-9]*' | grep -o '[0-9]*' || echo "0")
REG_FAIL=$(echo "$REG_OUTPUT" | grep -o 'Failed: *[0-9]*' | grep -o '[0-9]*' || echo "0")

if echo "$REG_OUTPUT" | grep -q "All golden standard tests PASSED"; then
  pass "  v0.1 回归全部通过 ($REG_PASS assertions)"
else
  fail "  v0.1 回归失败 ($REG_PASS passed, $REG_FAIL failed)"
fi

# ==============================================================================
# 汇总
# ==============================================================================
echo ""
echo "================================================================"
TOTAL=$((PASS + FAIL + WARN))
echo " v0.2 人工验收汇总: ${PASS}/${TOTAL} 通过, ${FAIL} 失败, ${WARN} 警告"
echo "================================================================"

if [ $FAIL -eq 0 ]; then
  echo ""
  echo " 🎉 v0.2 人工验收全部通过！"
  exit 0
else
  echo ""
  echo " ⚠️  有 $FAIL 项失败，请查看上方详情。"
  exit 1
fi
