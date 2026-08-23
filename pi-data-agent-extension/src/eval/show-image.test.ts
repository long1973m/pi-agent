/**
 * S1.2 show_image 工具验收测试
 *
 * 运行: npx tsx src/eval/show-image.test.ts
 *
 * 覆盖:
 * - V2.1: PNG 图片展示成功
 * - V2.2: SVG 图片展示成功
 * - V2.3: 路径越界被拦截
 * - V2.4: 文件不存在被拒绝
 * - V2.5: 非图片文件被拒绝
 * - V2.6: 无效图片文件被拒绝（magic bytes 不匹配）
 * - V2.7: 大文件 fallback（>2MB）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createShowImageTool } from "../tools/show-image.js";
import type { ToolContext } from "../tools/tool-context.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

/** 最小有效 PNG 文件（1x1 像素，红色） */
function createMinimalPng(): Buffer {
  // PNG 文件头: 89 50 4E 47 0D 0A 1A 0A
  // 后面跟 IHDR 和 IDAT 块
  // 这是一个预编码的 1x1 红色 PNG
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0x0f, 0x00, 0x00,
    0x01, 0x01, 0x00, 0x05, 0x18, 0xd8, 0x4e, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

/** 创建测试文件 */
function setupTestFiles() {
  mkdirSync(EVAL_DIR, { recursive: true });

  // 有效 PNG
  const pngPath = join(EVAL_DIR, "test.png");
  writeFileSync(pngPath, createMinimalPng());

  // 有效 SVG
  const svgPath = join(EVAL_DIR, "test.svg");
  writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>`);

  // 假的 PNG（扩展名 .png 但内容是文本）
  const fakePngPath = join(EVAL_DIR, "fake.png");
  writeFileSync(fakePngPath, "this is not a png file");

  // 非图片文件
  const txtPath = join(EVAL_DIR, "test.txt");
  writeFileSync(txtPath, "hello world");

  // 大文件（>2MB）
  const bigPath = join(EVAL_DIR, "big.png");
  const bigData = Buffer.alloc(3 * 1024 * 1024, 0);
  // 写入 PNG 头
  bigData[0] = 0x89; bigData[1] = 0x50; bigData[2] = 0x4e; bigData[3] = 0x47;
  writeFileSync(bigPath, bigData);

  return { pngPath, svgPath, fakePngPath, txtPath, bigPath };
}

/** 清理测试文件 */
function cleanupTestFiles(paths: string[]) {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

/** 模拟 ExtensionContext */
const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runShowImageTests(): Promise<void> {
  console.log("=== S1.2 Show Image Tool Acceptance Tests ===\n");
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

  // Setup
  const { pngPath, svgPath, fakePngPath, txtPath, bigPath } = setupTestFiles();

  const config = loadConfig();
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary: {} as any,
    queryMemory: {} as any,
  };

  const getRuntime = () => toolContext;
  const showImageTool = createShowImageTool({ getRuntime });

  // ========================================================================
  // V2.1 PNG 图片展示成功
  // ========================================================================
  console.log("\n[PNG image]");
  const pngResult = await showImageTool.execute("test-png", { file_path: pngPath }, undefined, undefined, mockCtx);
  const pngDetails = pngResult.details as Record<string, any> | undefined;
  const hasImageContent = pngResult.content.some((c: any) => c.type === "image");
  const hasTextContent = pngResult.content.some((c: any) => c.type === "text");
  assert("png: success flag", pngDetails?.success === true);
  assert("png: has image content", hasImageContent);
  assert("png: has text description", hasTextContent);
  assert("png: image mimeType is image/png", pngResult.content.some((c: any) => c.type === "image" && c.mimeType === "image/png"));

  // ========================================================================
  // V2.2 SVG 图片展示成功
  // ========================================================================
  console.log("\n[SVG image]");
  const svgResult = await showImageTool.execute("test-svg", { file_path: svgPath }, undefined, undefined, mockCtx);
  const svgDetails = svgResult.details as Record<string, any> | undefined;
  const svgHasImageContent = svgResult.content.some((c: any) => c.type === "image");
  assert("svg: success flag", svgDetails?.success === true);
  assert("svg: has image content", svgHasImageContent);
  assert("svg: image mimeType is image/svg+xml", svgResult.content.some((c: any) => c.type === "image" && c.mimeType === "image/svg+xml"));

  // ========================================================================
  // V2.3 路径越界被拦截
  // ========================================================================
  console.log("\n[security: out-of-bounds path]");
  const outOfBoundsResult = await showImageTool.execute("test-oob", { file_path: "/etc/passwd" }, undefined, undefined, mockCtx);
  const oobDetails = outOfBoundsResult.details as Record<string, any> | undefined;
  assert("out-of-bounds: blocked", oobDetails?.blocked === true);

  // ========================================================================
  // V2.4 文件不存在被拒绝
  // ========================================================================
  console.log("\n[validation: non-existent file]");
  const notFoundResult = await showImageTool.execute("test-notfound", { file_path: join(EVAL_DIR, "nonexistent.png") }, undefined, undefined, mockCtx);
  const nfDetails = notFoundResult.details as Record<string, any> | undefined;
  assert("not found: rejected", nfDetails?.error === "file_not_found");

  // ========================================================================
  // V2.5 非图片文件被拒绝
  // ========================================================================
  console.log("\n[validation: non-image file]");
  const txtResult = await showImageTool.execute("test-txt", { file_path: txtPath }, undefined, undefined, mockCtx);
  const txtDetails = txtResult.details as Record<string, any> | undefined;
  assert("non-image: rejected", txtDetails?.error === "unsupported_format");

  // ========================================================================
  // V2.6 无效图片文件被拒绝（magic bytes 不匹配）
  // ========================================================================
  console.log("\n[validation: invalid image magic bytes]");
  const fakeResult = await showImageTool.execute("test-fake", { file_path: fakePngPath }, undefined, undefined, mockCtx);
  const fakeDetails = fakeResult.details as Record<string, any> | undefined;
  assert("fake png: rejected", fakeDetails?.error === "invalid_image_file");

  // ========================================================================
  // V2.7 大文件 fallback（>2MB）
  // ========================================================================
  console.log("\n[fallback: oversized file]");
  const bigResult = await showImageTool.execute("test-big", { file_path: bigPath }, undefined, undefined, mockCtx);
  const bigDetails = bigResult.details as Record<string, any> | undefined;
  const bigContent0 = bigResult.content[0] as Record<string, any> | undefined;
  assert("oversized: error is file_too_large", bigDetails?.error === "file_too_large");
  assert("oversized: contains file path in text", (bigContent0?.text as string)?.includes(bigPath) ?? false);

  // Cleanup
  await engine.close();
  cleanupTestFiles([pngPath, svgPath, fakePngPath, txtPath, bigPath]);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runShowImageTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
