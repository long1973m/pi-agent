/**
 * S1.2 show_image — 展示本地图片文件
 *
 * 流程：
 * 1. 路径白名单检查（复用 SecurityChecker）
 * 2. 文件存在性检查
 * 3. 图片格式检查（PNG/JPG/SVG）
 * 4. 读取文件为 base64 → 构造 ImageContent
 * 5. 文件过大（>2MB）或格式不支持时 fallback 到文本路径
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";

/** show_image 参数 */
const ShowImageParams = Type.Object({
  file_path: Type.String({
    description: "要展示的图片文件路径（支持 PNG、JPG、SVG）",
  }),
});

/** 支持的图片格式 */
const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".svg"];

/** 对应的 MIME 类型 */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/** 文件大小限制（2MB） */
const MAX_FILE_SIZE = 2 * 1024 * 1024;

/** 通过 magic bytes 验证图片格式（仅 PNG/JPEG） */
function validateImageMagicBytes(filePath: string, ext: string): boolean {
  try {
    const fd = readFileSync(filePath);
    const header = fd.slice(0, 8);

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (ext === ".png") {
      return header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    }

    // JPEG: FF D8 FF
    if (ext === ".jpg" || ext === ".jpeg") {
      return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    }

    // SVG 通过文本内容验证（<?xml 或 <svg）
    if (ext === ".svg") {
      const text = fd.slice(0, 256).toString("utf-8").trim().toLowerCase();
      return text.startsWith("<?xml") || text.startsWith("<svg");
    }

    return false;
  } catch {
    return false;
  }
}

export function createShowImageTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "show_image",
    label: "Show Image",
    description:
      "Display a local image file (PNG, JPG, SVG). " +
      "Performs path whitelist check, file existence check, and image format validation. " +
      "If the image is too large (>2MB) or the TUI does not support inline images, returns the file path as text fallback.",
    parameters: ShowImageParams,
    execute: async (
      toolCallId: string,
      args: { file_path: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt) {
        return {
          content: [{ type: "text", text: "Error: Runtime not available." }],
          details: { toolName: "show_image", error: "runtime not available" },
        };
      }

      const filePath = args.file_path;
      const security = rt.security;

      // ======================================================================
      // 1. 路径白名单检查
      // ======================================================================

      const pathCheck = security.checkPath(filePath);
      if (pathCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${pathCheck.reason}` }],
          details: { toolName: "show_image", blocked: true, reason: pathCheck.reason },
        };
      }

      // ======================================================================
      // 2. 文件存在性检查
      // ======================================================================

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
          details: { toolName: "show_image", error: "file_not_found", filePath },
        };
      }

      // ======================================================================
      // 3. 图片格式检查
      // ======================================================================

      const ext = extname(filePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return {
          content: [{ type: "text", text: `Error: Unsupported image format "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}` }],
          details: { toolName: "show_image", error: "unsupported_format", supportedFormats: SUPPORTED_EXTENSIONS },
        };
      }

      if (!validateImageMagicBytes(filePath, ext)) {
        return {
          content: [{ type: "text", text: `Error: File "${filePath}" does not appear to be a valid ${ext} image.` }],
          details: { toolName: "show_image", error: "invalid_image_file", filePath, ext },
        };
      }

      // ======================================================================
      // 4. 文件大小检查
      // ======================================================================

      const stats = statSync(filePath);
      if (stats.size > MAX_FILE_SIZE) {
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        return {
          content: [{ type: "text", text: `Image too large to display inline (${sizeMb} MB > 2 MB limit).\nFile path: ${filePath}` }],
          details: { toolName: "show_image", error: "file_too_large", filePath, fileSize: stats.size },
        };
      }

      // ======================================================================
      // 5. 读取文件并构造 ImageContent
      // ======================================================================

      try {
        const imageData = readFileSync(filePath);
        const base64 = imageData.toString("base64");
        const mimeType = MIME_TYPES[ext] ?? "image/png";

        // 同时返回 image content 和文本描述（兼容所有 TUI 模式）
        const textDescription = `Image: ${filePath}\nFormat: ${ext}\nSize: ${(stats.size / 1024).toFixed(1)} KB`;

        return {
          content: [
            { type: "text", text: textDescription },
            { type: "image", data: base64, mimeType },
          ],
          details: {
            toolName: "show_image",
            success: true,
            filePath,
            format: ext,
            fileSize: stats.size,
            mimeType,
          },
        };
      } catch (err) {
        const errorMsg = `Error reading image file: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: errorMsg }],
          details: { toolName: "show_image", error: errorMsg },
        };
      }
    },
  };
}
