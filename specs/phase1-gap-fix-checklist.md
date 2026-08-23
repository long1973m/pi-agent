# Phase 1 衔接修复执行清单

> 来源：Phase 1 审查报告（基于 MVP-IMPLEMENTATION-STEPS.md v1.1）
> 日期：2026-06-24
> 状态：Phase 1 地基层 7 个模块代码已完成，但 Extension 入口未集成，需补充衔接步骤

---

## 背景

Phase 1 地基层（S1.1-S1.7）的 7 个模块代码已全部实现：
- `src/types.ts` — 共享类型定义
- `src/config.ts` — 配置管理
- `src/persistence.ts` — 三层持久化读写
- `src/security.ts` — P0 安全层
- `src/engine/duckdb.ts` — DuckDB 引擎
- `src/utils/dataset-fingerprint.ts` — 数据集指纹
- `src/utils/schema-fingerprint.ts` — Schema 指纹

但 `src/index.ts` 仍是 S0.1 的 PoC 代码，**未初始化任何 Phase 1 模块**。Phase 1 验收要求这些模块能被 Extension 正确加载和使用，因此需要补充衔接步骤。

---

## 新增步骤 S1.8：升级 Extension 入口（`src/index.ts`）

### 目标
将 `src/index.ts` 从 S0.1 PoC 升级为 Phase 1 完整 Extension 入口，初始化所有地基层模块。

### 具体任务

#### 1. 保留 S0.1 验证能力（向后兼容）
- [ ] `poc_dummy` 工具继续注册，但改为可选（通过环境变量或配置开关控制）
- [ ] 生命周期事件（`session_start` / `session_shutdown` / `before_agent_start`）继续监听
- [ ] `sessionManager.getBranch()` 调用保留（已验证通过）

#### 2. 初始化 Phase 1 核心模块
- [ ] 在 `factory` 函数内创建 `PersistenceManager` 实例
  ```typescript
  const persistence = new PersistenceManager(
    config.globalConfigDir,
    config.projectConfigDir
  );
  ```
- [ ] 创建 `SecurityChecker` 实例
  ```typescript
  const security = createDefaultSecurityChecker(config.cwd);
  ```
- [ ] 创建 `DuckDBEngine` 实例并初始化
  ```typescript
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();
  ```
- [ ] 在 `session_shutdown` 事件中调用 `engine.close()`

#### 3. 模块间依赖注入
- [ ] 将 `security`、`engine`、`persistence` 实例存入 Extension 上下文（如 `sessionData` Map 或自定义上下文对象）
- [ ] 确保后续工具（Phase 2）能访问这些实例

#### 4. 错误处理
- [ ] `engine.init()` 失败时记录错误并优雅降级（如禁用数据功能但保持 Extension 可加载）
- [ ] `session_shutdown` 时确保 `engine.close()` 被调用（即使之前有错误）

### 验收标准
- [ ] `npm run build` 编译通过，无 TypeScript 错误
- [ ] `npm run poc:duckdb` 仍能正常运行（向后兼容）
- [ ] Extension 加载时控制台输出初始化日志（如 `[DuckDBEngine] Connected to ...`）

---

## 新增步骤 S1.9：集成验证

### 目标
验证 Extension 入口能正确加载和初始化所有 Phase 1 模块，无运行时错误。

### 具体任务

#### 1. 编译验证
- [ ] 运行 `npm run build`，确认 `dist/index.js` 生成成功
- [ ] 检查 `dist/index.d.ts` 类型声明文件是否存在

#### 2. 运行时验证（手动）
- [ ] 在 Pi CLI 中加载该 Extension（参考 S0.1 的加载方式）
- [ ] 确认 `session_start` 事件触发，且 `DuckDBEngine` 初始化成功
- [ ] 确认 `sessionManager.getBranch()` 调用正常
- [ ] 确认 `session_shutdown` 事件触发，且 `engine.close()` 被调用

#### 3. 模块间连通性验证
- [ ] 在 `poc_dummy` 工具的 execute 函数中，尝试访问 `engine` 实例（如调用 `engine.query("SELECT 1")`）
- [ ] 验证安全层能拦截越界路径（如尝试访问 `/etc/passwd`）
- [ ] 验证持久化能读写数据（如保存/读取一个测试配置项）

### 验收标准
- [ ] Extension 在 Pi 中加载无报错
- [ ] `session_start` → 模块初始化 → `session_shutdown` → 模块清理 全流程无内存泄漏或资源未释放
- [ ] 至少一个模块间调用成功（如 `engine.query()` 返回正确结果）

---

## 关键路径更新

```
S1.1 ✅ → S1.2 ✅ → S1.3 ✅ → S1.4 ✅ → S1.5 ✅ → S1.6 ✅ → S1.7 ✅
                                                                        ↓
                                                              【S1.8】升级 src/index.ts
                                                                        ↓
                                                              【S1.9】集成验证
                                                                        ↓
                                                              Phase 1 正式通过
                                                                        ↓
                                                              S2.1 (load_data) → ...
```

---

## 风险项

| 风险 | 影响 | 缓解 |
|------|------|------|
| `src/index.ts` 升级时破坏 S0.1 验证能力 | 需回滚 | 保留 `poc_dummy` 工具，用配置开关控制 |
| `DuckDBEngine.init()` 在 Extension 加载时失败 | Extension 无法使用 | 优雅降级：记录错误，禁用数据功能但保持 Extension 可加载 |
| 模块间循环依赖 | 编译失败 | 确保导入顺序：types → config → persistence → security → engine → index |

---

## 完成后通知审查者

S1.8 和 S1.9 完成后，请通知审查者重新审查 Phase 1，确认可以进入 Phase 2。
