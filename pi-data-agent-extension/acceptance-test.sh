#!/bin/bash
# ==============================================================================
# Pi Data Agent Extension — 人工验收脚本
#
# 用途：按步骤验证 MVP 交付物是否满足 Spec 要求
# 运行：bash acceptance-test.sh
# 前提：cd pi-data-agent-extension && npm install 已完成
# ==============================================================================

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN + 1)); }

echo "================================================================"
echo " Pi Data Agent Extension — 人工验收脚本"
echo " 日期: $(date +%Y-%m-%d)"
echo "================================================================"

# ==============================================================================
# Step 0: 环境检查
# ==============================================================================
echo ""
echo "[Step 0] 环境检查"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  pass "Node.js: $NODE_VER"
else
  fail "Node.js 未安装"
fi

if command -v npx &>/dev/null; then
  pass "npx 可用"
else
  fail "npx 不可用"
fi

if [ -f "node_modules/@duckdb/node-api/package.json" ]; then
  pass "DuckDB 已安装"
else
  fail "DuckDB 未安装 (npm install)"
fi

if [ -f "node_modules/@earendil-works/pi-coding-agent/package.json" ]; then
  pass "Pi SDK 已安装"
else
  fail "Pi SDK 未安装"
fi

# ==============================================================================
# Step 1: TypeScript 编译
# ==============================================================================
echo ""
echo "[Step 1] TypeScript 编译"

COMPILE_OUTPUT=$(npm run check 2>&1)
COMPILE_EXIT=$?

if [ $COMPILE_EXIT -eq 0 ]; then
  pass "npm run check 零错误 (exit code: 0)"
else
  ERROR_COUNT=$(echo "$COMPILE_OUTPUT" | grep -c "error TS" || true)
  fail "npm run check 有 $ERROR_COUNT 个编译错误"
fi

# ==============================================================================
# Step 2: 构建产物
# ==============================================================================
echo ""
echo "[Step 2] 构建"

npm run build 2>&1
if [ -f "dist/index.js" ]; then
  pass "构建成功: dist/index.js 存在"
  BUILD_SIZE=$(wc -c < dist/index.js | tr -d ' ')
  pass "构建产物大小: $(echo $BUILD_SIZE | numfmt --to=iec 2>/dev/null || echo "${BUILD_SIZE} bytes")"
else
  fail "构建失败: dist/index.js 不存在"
fi

# ==============================================================================
# Step 3: Phase 2 工具闭环测试
# ==============================================================================
echo ""
echo "[Step 3] Phase 2 工具闭环 (poc-phase2.ts)"

PHASE2_OUTPUT=$(npx tsx src/poc-phase2.ts 2>&1)
PHASE2_EXIT=$?

if [ $PHASE2_EXIT -eq 0 ]; then
  PHASE2_PASS=$(echo "$PHASE2_OUTPUT" | grep -c "✅" || true)
  PHASE2_FAIL=$(echo "$PHASE2_OUTPUT" | grep -c "❌" || true)
  pass "Phase 2 全部通过: ${PHASE2_PASS}/$((PHASE2_PASS + PHASE2_FAIL))"

  # 逐项检查（断言名与 poc-phase2.ts 中 assert() 一致）
  echo "$PHASE2_OUTPUT" | grep 'load tableName in details' | grep -q '✅' && pass "  load_data: tableName 正确" || fail "  load_data: tableName 缺失"
  echo "$PHASE2_OUTPUT" | grep 'query count has species data' | grep -q '✅' && pass "  query_data: species 分组正确" || fail "  query_data: species 分组失败"
  echo "$PHASE2_OUTPUT" | grep 'DROP TABLE blocked' | grep -q '✅' && pass "  安全层: DROP TABLE 拦截" || fail "  安全层: DROP TABLE 未拦截"
else
  fail "Phase 2 测试失败 (exit code: $PHASE2_EXIT)"
fi

# ==============================================================================
# Step 4: Phase 6 金标准回归测试
# ==============================================================================
echo ""
echo "[Step 4] Phase 6 金标准回归 (regression.test.ts)"

PHASE6_OUTPUT=$(npx tsx src/eval/regression.test.ts 2>&1)
PHASE6_EXIT=$?

if [ $PHASE6_EXIT -eq 0 ]; then
  PHASE6_PASS=$(echo "$PHASE6_OUTPUT" | grep -c "✅" || true)
  PHASE6_FAIL=$(echo "$PHASE6_OUTPUT" | grep -c "❌" || true)
  pass "Phase 6 全部通过: ${PHASE6_PASS}/$((PHASE6_PASS + PHASE6_FAIL))"

  # 关键验收项
  echo "$PHASE6_OUTPUT" | grep "setosa count = 10" | grep -q "✅" && pass "  数值正确性: setosa = 10" || fail "  数值正确性: setosa ≠ 10"
  echo "$PHASE6_OUTPUT" | grep "versicolor count = 10" | grep -q "✅" && pass "  数值正确性: versicolor = 10" || fail "  数值正确性: versicolor ≠ 10"
  echo "$PHASE6_OUTPUT" | grep "virginica count = 10" | grep -q "✅" && pass "  数值正确性: virginica = 10" || fail "  数值正确性: virginica ≠ 10"
  echo "$PHASE6_OUTPUT" | grep "INSERT requires confirm" | grep -q "✅" && pass "  安全层: INSERT 需确认" || fail "  安全层: INSERT 未需确认"
  echo "$PHASE6_OUTPUT" | grep "CTAS requires confirm" | grep -q "✅" && pass "  安全层: CTAS 需确认" || fail "  安全层: CTAS 未需确认"
  echo "$PHASE6_OUTPUT" | grep "open-ended '分析一下这些数据' triggers clarify" | grep -q "✅" && pass "  主动反问: 开放式表达触发" || fail "  主动反问: 开放式表达未触发"
  echo "$PHASE6_OUTPUT" | grep "open-ended has 3 options" | grep -q "✅" && pass "  主动反问: 返回3个选项" || fail "  主动反问: 选项数不对"
  echo "$PHASE6_OUTPUT" | grep "open-ended '帮我看看这个表' triggers clarify" | grep -q "✅" && pass "  主动反问: 模糊查询触发" || fail "  主动反问: 模糊查询未触发"
  echo "$PHASE6_OUTPUT" | grep "clear '统计各品种数量' not ambiguous" | grep -q "✅" && pass "  主动反问: 明确查询不触发" || fail "  主动反问: 明确查询误触发"
  echo "$PHASE6_OUTPUT" | grep "clear '按 species 分组统计数量' not ambiguous" | grep -q "✅" && pass "  主动反问: 带维度查询不触发" || fail "  主动反问: 带维度查询误触发"
  echo "$PHASE6_OUTPUT" | grep "convergence: second clear query not ambiguous" | grep -q "✅" && pass "  收敛性: 同口径不重复反问" || fail "  收敛性: 同口径重复反问"
  echo "$PHASE6_OUTPUT" | grep "missing user_intent returns error" | grep -q "✅" && pass "  query_data: 缺少user_intent报错" || fail "  query_data: 缺少user_intent未报错"
  echo "$PHASE6_OUTPUT" | grep 'export returns outputPath' | grep -q '✅' && pass "  export_result: 路径正确" || fail "  export_result: 路径缺失"
  echo "$PHASE6_OUTPUT" | grep 'export returns rowCount' | grep -q '✅' && pass "  export_result: 行数正确" || fail "  export_result: 行数缺失"
  echo "$PHASE6_OUTPUT" | grep 'export blocks write SQL' | grep -q '✅' && pass "  export_result: 写操作拦截" || fail "  export_result: 写操作未拦截"
  echo "$PHASE6_OUTPUT" | grep 'export rejects unsupported format' | grep -q '✅' && pass "  export_result: 非法格式拒绝" || fail "  export_result: 非法格式未拒绝"
else
  fail "Phase 6 测试失败 (exit code: $PHASE6_EXIT)"
fi

# ==============================================================================
# Step 5: 安全层专项
# ==============================================================================
echo ""
echo "[Step 5] 安全层专项验证"

# 5.1: 危险 SQL 拦截
cat > .sec-check-temp.ts << 'SEC_EOF'
import { loadConfig, toSecurityConfig } from './src/config.js';
import { SecurityChecker } from './src/security.js';
const config = loadConfig();
const sec = new SecurityChecker(toSecurityConfig(config));

const drop = sec.checkSql('DROP TABLE iris;');
console.log('DROP:', drop.action === 'block' ? 'BLOCKED' : 'NOT_BLOCKED');

const del = sec.checkSql('DELETE FROM iris;');
console.log('DELETE:', del.action === 'block' ? 'BLOCKED' : 'NOT_BLOCKED');

const sel = sec.checkSql('SELECT * FROM iris');
console.log('SELECT:', sel.action === 'allow' ? 'ALLOWED' : 'NOT_ALLOWED');

const ins = sec.checkSql('INSERT INTO iris VALUES (1,2,3,4,"test")');
console.log('INSERT:', ins.action === 'confirm' ? 'CONFIRM' : 'NOT_CONFIRM');

const ctas = sec.checkSql('CREATE TABLE tmp AS SELECT * FROM iris');
console.log('CTAS:', ctas.action === 'confirm' ? 'CONFIRM' : 'NOT_CONFIRM');

const upd = sec.checkSql('UPDATE iris SET name = 1');
console.log('UPDATE:', upd.action === 'block' ? 'BLOCKED' : 'NOT_BLOCKED');

const path1 = sec.checkPath('/etc/passwd');
console.log('OUT_OF_BOUNDS:', path1.action === 'block' || path1.action === 'confirm' ? 'BLOCKED_OR_CONFIRM' : 'NOT_BLOCKED');
SEC_EOF
SEC_OUTPUT=$(npx tsx .sec-check-temp.ts 2>&1)
SEC_EXIT=$?
rm -f .sec-check-temp.ts .sec-check-temp.js

if [ $SEC_EXIT -ne 0 ]; then
  echo "$SEC_OUTPUT" | tail -3
  fail "  安全层专项执行失败 (exit: $SEC_EXIT)"
fi

echo "$SEC_OUTPUT" | grep "DROP: BLOCKED" | grep -q "BLOCKED" && pass "  DROP TABLE 拦截" || fail "  DROP TABLE 未拦截"
echo "$SEC_OUTPUT" | grep "DELETE: BLOCKED" | grep -q "BLOCKED" && pass "  DELETE 无 WHERE 拦截" || fail "  DELETE 无 WHERE 未拦截"
echo "$SEC_OUTPUT" | grep "SELECT: ALLOWED" | grep -q "ALLOWED" && pass "  SELECT 放行" || fail "  SELECT 未放行"
echo "$SEC_OUTPUT" | grep "INSERT: CONFIRM" | grep -q "CONFIRM" && pass "  INSERT 需确认" || fail "  INSERT 未需确认"
echo "$SEC_OUTPUT" | grep "CTAS: CONFIRM" | grep -q "CONFIRM" && pass "  CTAS 需确认" || fail "  CTAS 未需确认"
echo "$SEC_OUTPUT" | grep "UPDATE: BLOCKED" | grep -q "BLOCKED" && pass "  UPDATE 无 WHERE 拦截" || fail "  UPDATE 无 WHERE 未拦截"
echo "$SEC_OUTPUT" | grep "OUT_OF_BOUNDS: BLOCKED_OR_CONFIRM" | grep -q "BLOCKED" && pass "  越界路径拦截" || fail "  越界路径未拦截"

# ==============================================================================
# Step 6: 文件完整性
# ==============================================================================
echo ""
echo "[Step 6] 文件完整性"

# 核心源文件
CORE_FILES=(
  "src/types.ts"
  "src/config.ts"
  "src/persistence.ts"
  "src/security.ts"
  "src/engine/duckdb.ts"
  "src/error-recovery.ts"
  "src/index.ts"
)

for f in "${CORE_FILES[@]}"; do
  if [ -f "$f" ]; then
    pass "  $f 存在"
  else
    fail "  $f 缺失"
  fi
done

# 工具文件
TOOL_FILES=(
  "src/tools/tool-context.ts"
  "src/tools/load-data.ts"
  "src/tools/describe-data.ts"
  "src/tools/query-data.ts"
  "src/tools/transform-data.ts"
  "src/tools/list-datasets.ts"
  "src/tools/ask-clarification.ts"
  "src/tools/export-result.ts"
)

for f in "${TOOL_FILES[@]}"; do
  if [ -f "$f" ]; then
    pass "  $f 存在"
  else
    fail "  $f 缺失"
  fi
done

# Hook 文件
HOOK_FILES=(
  "src/hooks/data-dictionary.ts"
  "src/hooks/query-memory.ts"
  "src/hooks/active-questioning.ts"
)

for f in "${HOOK_FILES[@]}"; do
  if [ -f "$f" ]; then
    pass "  $f 存在"
  else
    fail "  $f 缺失"
  fi
done

# Skill 文件
if [ -f "skills/data-exploration/SKILL.md" ]; then
  pass "  SKILL.md 存在"
else
  fail "  SKILL.md 缺失"
fi

if [ -f "skills/data-exploration/scripts/overview.sql" ]; then
  pass "  overview.sql 存在"
else
  fail "  overview.sql 缺失"
fi

# ==============================================================================
# 汇总
# ==============================================================================
echo ""
echo "================================================================"
TOTAL=$((PASS + FAIL + WARN))
echo " 验收汇总: ${PASS}/${TOTAL} 通过, ${FAIL} 失败, ${WARN} 警告"
echo "================================================================"

if [ $FAIL -eq 0 ]; then
  echo ""
  echo " 🎉 人工验收全部通过！MVP 交付合格。"
  exit 0
else
  echo ""
  echo " ⚠️  有 $FAIL 项失败，请查看上方详情。"
  exit 1
fi
