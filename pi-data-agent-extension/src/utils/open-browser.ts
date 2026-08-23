/**
 * Task 5 — 跨平台自动打开浏览器
 *
 * 按平台分支：
 * - darwin (macOS) → open
 * - win32 → start
 * - linux → xdg-open
 *
 * 使用 spawn + 参数数组，正确处理路径中的空格和特殊字符。
 * 失败时降级为终端打印路径，不抛错。
 */

import { spawn } from "node:child_process";

/**
 * 用系统默认浏览器打开文件/URL
 *
 * @param filePath - 要打开的文件绝对路径或 URL
 * @returns 是否成功打开
 */
export async function openBrowser(filePath: string): Promise<boolean> {
  let command: string;
  let args: string[];

  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [filePath];
      break;
    case "win32":
      // start 是 cmd 内建命令，需要通过 cmd /c 调用
      command = "cmd";
      args = ["/c", "start", "", filePath];
      break;
    default:
      command = "xdg-open";
      args = [filePath];
      break;
  }

  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });

    child.on("error", (err) => {
      console.warn(`[open-browser] Failed to open browser: ${err.message}`);
      console.log(`[open-browser] Fallback: report available at ${filePath}`);
      resolve(false);
    });

    child.on("spawn", () => {
      // 父进程不等待子进程（浏览器打开后独立运行）
      child.unref();
      resolve(true);
    });
  });
}