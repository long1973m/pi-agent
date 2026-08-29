/**
 * Pi Data Agent Dashboard — 配置常量
 */

/** 默认端口 */
export const DEFAULT_PORT = 3456;

/** 最大端口尝试范围 */
export const MAX_PORT_ATTEMPTS = 10;

/** 端口范围结束 */
export const MAX_PORT = DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1;

/** 绑定地址（固定 localhost） */
export const BIND_HOST = "127.0.0.1";

/** 请求体大小限制（256KB） */
export const BODY_SIZE_LIMIT = "256kb";

/**
 * 上传路由专用请求体限制（70MB）。
 * v0.10.1 修复：全局 256kb 会把 >约190KB 的真实 CSV（base64 膨胀 1/3 后）全部 413 拒绝；
 * 仅 /api/upload 挂载该专用解析器，50MB 文件 base64 后约 67MB，留有余量。
 */
export const UPLOAD_BODY_SIZE_LIMIT = "70mb";

/**
 * 写令牌 header 名称（R-1 收敛：单一出处为主 config.ts 的 "X-Write-Token"，
 * 此处转出供 dashboard 中间件沿用原导入路径；HTTP 头大小写不敏感，
 * 服务端读取时本就统一 toLowerCase()）。
 */
export { WRITE_TOKEN_HEADER } from "../config.js";

/** 数据预览默认行数 */
export const PREVIEW_DEFAULT_ROWS = 50;

/** 数据预览最大行数 */
export const PREVIEW_MAX_ROWS = 200;

/** 列统计超时（毫秒） */
export const STATS_TIMEOUT_MS = 5000;

/** 列统计最大列数 */
export const STATS_MAX_COLUMNS = 100;