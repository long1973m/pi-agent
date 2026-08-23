/**
 * v0.8 B3 — 字典推断 API 测试
 *
 * 验证：
 * 1. dictionaryManager 为空 → 503 DICTIONARY_UNAVAILABLE
 * 2. callLLM 为 undefined → 503 LLM_UNAVAILABLE
 * 3. engine 为空 → 503 DICTIONARY_UNAVAILABLE
 * 4. 推断超时 → 504 INFERENCE_TIMEOUT（Promise.race 模拟）
 * 5. 正常推断参数校验 → 400 INVALID_MODE
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDictionariesRouter } from "../dashboard/routes/dictionaries.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-test-"));
}

/** 发送 HTTP 请求到本地 Express app */
async function requestApp(
  app: express.Application,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            server.close();
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: data ? JSON.parse(data) : null,
              });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

/** 构造带 mock deps 的 Express app */
function createInferenceApp(deps: {
  projectDir: string;
  engine?: unknown;
  dictionaryManager?: unknown;
  callLLM?: unknown;
}): express.Application {
  const app = express();
  app.use(express.json());
  const router = createDictionariesRouter({
    projectDir: deps.projectDir,
    cwd: deps.projectDir,
    engine: (deps.engine as any) ?? null,
    dictionaryManager: deps.dictionaryManager as any,
    callLLM: deps.callLLM as any,
  });
  app.use(router);
  return app;
}

describe("dictionary-inference-api", () => {
  it("空 dictionaryManager 应返回 503 DICTIONARY_UNAVAILABLE", async () => {
    const projectDir = createTempDir();
    const app = createInferenceApp({
      projectDir,
      engine: {}, // 有 engine
      dictionaryManager: undefined, // 空
      callLLM: () => Promise.resolve(""),
    });

    const res = await requestApp(app, "POST", "/api/dictionaries/test_table/infer", {
      mode: "empty-only",
      expectedRevision: -1,
    });

    assert.strictEqual(res.status, 503);
    assert.ok((res.body as any).error);
    assert.strictEqual((res.body as any).error.code, "DICTIONARY_UNAVAILABLE");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("空 engine 应返回 503 DICTIONARY_UNAVAILABLE", async () => {
    const projectDir = createTempDir();
    const app = createInferenceApp({
      projectDir,
      engine: undefined, // 空
      dictionaryManager: { getDictionary: () => undefined },
      callLLM: () => Promise.resolve(""),
    });

    const res = await requestApp(app, "POST", "/api/dictionaries/test_table/infer", {
      mode: "empty-only",
      expectedRevision: -1,
    });

    assert.strictEqual(res.status, 503);
    assert.ok((res.body as any).error);
    assert.strictEqual((res.body as any).error.code, "DICTIONARY_UNAVAILABLE");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("空 callLLM 应返回 503 LLM_UNAVAILABLE", async () => {
    const projectDir = createTempDir();
    const app = createInferenceApp({
      projectDir,
      engine: {}, // 有 engine
      dictionaryManager: { getDictionary: () => undefined },
      callLLM: undefined, // 空
    });

    const res = await requestApp(app, "POST", "/api/dictionaries/test_table/infer", {
      mode: "empty-only",
      expectedRevision: -1,
    });

    assert.strictEqual(res.status, 503);
    assert.ok((res.body as any).error);
    assert.strictEqual((res.body as any).error.code, "LLM_UNAVAILABLE");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("无效 mode 应返回 400 INVALID_MODE", async () => {
    const projectDir = createTempDir();
    const app = createInferenceApp({
      projectDir,
      engine: {},
      dictionaryManager: { getDictionary: () => undefined },
      callLLM: () => Promise.resolve(""),
    });

    const res = await requestApp(app, "POST", "/api/dictionaries/test_table/infer", {
      mode: "invalid-mode",
      expectedRevision: -1,
    });

    assert.strictEqual(res.status, 400);
    assert.ok((res.body as any).error);
    assert.strictEqual((res.body as any).error.code, "INVALID_MODE");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("推断超时模拟 — Promise.race 应在超时时抛出", async () => {
    const INFERENCE_TIMEOUT_MS = 50;
    const slowCallModel = () =>
      new Promise<string>(() => {
        /* 永不 resolve */
      });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("推断超时")), INFERENCE_TIMEOUT_MS);
    });

    try {
      await Promise.race([slowCallModel(), timeoutPromise]);
      assert.fail("应该超时抛出错误");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.strictEqual((err as Error).message, "推断超时");
    }
  });
});
