import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadConfig, type AppConfig } from "../config.js";

let root: string;

beforeEach(() => {
  // Isolate all caller-provided configuration, preserving it for afterEach.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_DATA_AGENT_")) vi.stubEnv(key, undefined);
  }
  root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeProject(cwd: string, config: Partial<AppConfig>): void {
  const dir = join(cwd, ".pi-data-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function expectDefaults(config: AppConfig, cwd: string): void {
  expect(config.cwd).toBe(cwd);
  expect(config.projectConfigDir).toBe(join(cwd, ".pi-data-agent"));
  expect(config.dbPath).toBe(join(cwd, ".pi-data-agent", "session.duckdb"));
  expect(config.outputDir).toBe(join(cwd, ".pi-data-agent", "output"));
  expect(config.uploadsDir).toBe(join(cwd, ".pi-data-agent", "uploads"));
  expect(config.allowedPaths).toEqual([cwd, config.uploadsDir]);
  expect(config.globalConfigDir).toBe(join(homedir(), ".config", "pi-data-agent"));
}

describe("loadConfig per-load defaults", () => {
  it("derives default paths from an override cwd", () => {
    expectDefaults(loadConfig({ cwd: root }), root);
  });

  it("resolves a relative override cwd before deriving defaults", () => {
    expectDefaults(loadConfig({ cwd: relative(process.cwd(), root) }), root);
  });

  it("derives default paths from the environment cwd", () => {
    vi.stubEnv("PI_DATA_AGENT_CWD", root);
    expectDefaults(loadConfig(), root);
  });

  it("reads process.cwd at each load, not at module import", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    expectDefaults(loadConfig(), root);
    const next = join(root, "next");
    cwd.mockReturnValue(next);
    expectDefaults(loadConfig(), next);
  });

  it("derives defaults from project cwd without recursively loading another project", () => {
    const effectiveCwd = join(root, "effective");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeProject(root, { cwd: effectiveCwd, previewLimit: 23 });
    writeProject(effectiveCwd, { previewLimit: 99 });
    const config = loadConfig();
    expectDefaults(config, effectiveCwd);
    expect(config.previewLimit).toBe(23);
  });

  it("returns independent config objects and default arrays", () => {
    const first = loadConfig({ cwd: root });
    const second = loadConfig({ cwd: root });
    expect(first).not.toBe(second);
    expect(first.allowedPaths).not.toBe(second.allowedPaths);
    expect(first.dbAllowedHosts).not.toBe(second.dbAllowedHosts);
    first.allowedPaths.push(join(root, "extra"));
    first.dbAllowedHosts.push("db.example");
    first.previewLimit = 1;
    expect(second.dbAllowedHosts).toEqual([]);
    expect(second.previewLimit).toBe(100);
    expectDefaults(second, root);
    expect(loadConfig({ cwd: root }).dbAllowedHosts).toEqual([]);
  });

  it("does not alias or mutate caller arrays reused across loads", () => {
    const allowedPaths = [join(root, "data")];
    const dbAllowedHosts = ["db.example:3306"];
    const overrides = { cwd: root, allowedPaths, dbAllowedHosts };
    const first = loadConfig(overrides);
    const second = loadConfig(overrides);
    expect(first.allowedPaths).not.toBe(allowedPaths);
    expect(first.dbAllowedHosts).not.toBe(dbAllowedHosts);
    expect(first.dbAllowedHosts).not.toBe(second.dbAllowedHosts);
    first.allowedPaths.push(join(root, "extra"));
    first.dbAllowedHosts.push("other.example");
    expect(allowedPaths).toEqual([join(root, "data")]);
    expect(dbAllowedHosts).toEqual(["db.example:3306"]);
    expect(second.dbAllowedHosts).toEqual(dbAllowedHosts);
  });
});

describe("loadConfig explicit paths and precedence", () => {
  it("preserves explicit absolute paths from project and overrides", () => {
    const paths = {
      dbPath: join(root, "custom.duckdb"),
      globalConfigDir: join(root, "global"),
      projectConfigDir: join(root, "project"),
      outputDir: join(root, "output"),
      uploadsDir: join(root, "uploads"),
      allowedPaths: [join(root, "data"), join(root, "uploads")],
    };
    writeProject(root, paths);
    expect(loadConfig({ cwd: root })).toMatchObject(paths);
    expect(loadConfig({ cwd: join(root, "other"), ...paths })).toMatchObject(paths);
  });

  it("keeps explicit relative override paths resolved against cwd (global against home)", () => {
    const config = loadConfig({
      cwd: root, dbPath: "custom.duckdb", projectConfigDir: "state",
      outputDir: "results", uploadsDir: "incoming", globalConfigDir: "custom-global",
    });
    expect(config).toMatchObject({
      dbPath: join(root, "custom.duckdb"), projectConfigDir: join(root, "state"),
      outputDir: join(root, "results"), uploadsDir: join(root, "incoming"),
      globalConfigDir: resolve(homedir(), "custom-global"),
    });
  });

  it("preserves project-relative paths even when project cwd changes defaults", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeProject(root, {
      cwd: join(root, "effective"), dbPath: "custom.duckdb",
      outputDir: "results", allowedPaths: ["data"],
    });
    const config = loadConfig();
    expect(config.dbPath).toBe(join(root, "custom.duckdb"));
    expect(config.outputDir).toBe(join(root, "results"));
    expect(config.allowedPaths).toContain(join(root, "data"));
    expect(config.uploadsDir).toBe(join(root, "effective", ".pi-data-agent", "uploads"));
  });

  it("applies overrides > env > project > defaults", () => {
    expect(loadConfig({ cwd: root })).toMatchObject({ previewLimit: 100, dbAllowedHosts: [], dbQueryTimeoutMs: 300000 });
    writeProject(root, { previewLimit: 20, dbAllowedHosts: ["project.example"], dbQueryTimeoutMs: 20000, dbPath: "project.duckdb" });
    expect(loadConfig({ cwd: root })).toMatchObject({ previewLimit: 20, dbAllowedHosts: ["project.example"], dbQueryTimeoutMs: 20000, dbPath: join(root, "project.duckdb") });
    vi.stubEnv("PI_DATA_AGENT_PREVIEW_LIMIT", "30");
    vi.stubEnv("PI_DATA_AGENT_DB_ALLOWED_HOSTS", " env.example ; env.example:3306 ; ");
    vi.stubEnv("PI_DATA_AGENT_DB_QUERY_TIMEOUT_MS", "30000");
    vi.stubEnv("PI_DATA_AGENT_DB_PATH", "env.duckdb");
    expect(loadConfig({ cwd: root })).toMatchObject({ previewLimit: 30, dbAllowedHosts: ["env.example", "env.example:3306"], dbQueryTimeoutMs: 30000, dbPath: join(root, "env.duckdb") });
    expect(loadConfig({ cwd: root, previewLimit: 40, dbAllowedHosts: [], dbQueryTimeoutMs: 40000, dbPath: "override.duckdb" })).toMatchObject({ previewLimit: 40, dbAllowedHosts: [], dbQueryTimeoutMs: 40000, dbPath: join(root, "override.duckdb") });
  });

  it("uses override cwd before env cwd for project discovery and defaults", () => {
    const envCwd = join(root, "env");
    const overrideCwd = join(root, "override");
    writeProject(envCwd, { cwd: join(root, "ignored-env-project"), previewLimit: 20 });
    writeProject(overrideCwd, { cwd: join(root, "ignored-override-project"), previewLimit: 30 });
    vi.stubEnv("PI_DATA_AGENT_CWD", envCwd);
    const fromEnv = loadConfig();
    expectDefaults(fromEnv, envCwd);
    expect(fromEnv.previewLimit).toBe(20);
    const fromOverride = loadConfig({ cwd: overrideCwd });
    expectDefaults(fromOverride, overrideCwd);
    expect(fromOverride.previewLimit).toBe(30);
  });

  it("allows an empty env host list to replace project hosts", () => {
    writeProject(root, { dbAllowedHosts: ["project.example"] });
    vi.stubEnv("PI_DATA_AGENT_DB_ALLOWED_HOSTS", " ;  ");
    expect(loadConfig({ cwd: root }).dbAllowedHosts).toEqual([]);
  });
});

describe("loadConfig timeout normalization", () => {
  it.each([
    [0, 5000], [4999, 5000], [5000, 5000], [12345.6, 12346],
    [600000, 600000], [600001, 600000], [NaN, 300000], [Infinity, 300000],
  ])("normalizes override %s to %s ms", (input, expected) => {
    expect(loadConfig({ cwd: root, dbQueryTimeoutMs: input }).dbQueryTimeoutMs).toBe(expected);
  });

  it("normalizes after precedence and falls back for invalid env timeout", () => {
    writeProject(root, { dbQueryTimeoutMs: 1 });
    expect(loadConfig({ cwd: root }).dbQueryTimeoutMs).toBe(5000);
    vi.stubEnv("PI_DATA_AGENT_DB_QUERY_TIMEOUT_MS", "999999");
    expect(loadConfig({ cwd: root }).dbQueryTimeoutMs).toBe(600000);
    expect(loadConfig({ cwd: root, dbQueryTimeoutMs: 12345.6 }).dbQueryTimeoutMs).toBe(12346);
    vi.stubEnv("PI_DATA_AGENT_DB_QUERY_TIMEOUT_MS", "invalid");
    expect(loadConfig({ cwd: root }).dbQueryTimeoutMs).toBe(300000);
  });
});
