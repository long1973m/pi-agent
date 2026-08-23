/**
 * 通过 HTTP 直接调用 LLM API
 *
 * 支持两种 API 格式：
 * - OpenAI 兼容（openai-responses / openai-completions）：POST /v1/chat/completions
 * - Anthropic 兼容（anthropic-messages）：POST /v1/messages
 *
 * 不硬编码特定 provider，根据 baseUrl 和 api 自动适配。
 * 使用 Node.js 内置 fetch（18+），不引入外部依赖。
 *
 * v0.9 增强：
 * - 指数退避重试（429 / 5xx / 网络错误，最多 2 次）
 * - SSE 流式输出支持（可选 onStream 回调）
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallLLMOptions {
  /** API base URL（如 https://api.openai.com 或 https://api.anthropic.com） */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** API 格式：openai-responses | anthropic-messages | openai-completions */
  api: "openai-responses" | "openai-completions" | "anthropic-messages" | string;
  /** 模型 ID */
  modelId: string;
  /** 最大输出 token */
  maxTokens?: number;
  /** 超时时间 ms，默认 60_000 */
  timeoutMs?: number;
  /** 额外请求头（model.headers 合并） */
  headers?: Record<string, string>;
  /** 最大重试次数（默认 2），仅对 429/5xx/网络错误重试 */
  maxRetries?: number;
  /** 流式输出回调，收到增量文本时调用 */
  onStream?: (delta: string, fullText: string) => void;
}

export interface CallLLMResult {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** 实际重试次数 */
  retryCount?: number;
}

// ---------------------------------------------------------------------------
// retry helper
// ---------------------------------------------------------------------------

/** 判断 HTTP 状态码是否可重试 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** 指数退避延迟计算 */
function backoffDelay(attempt: number, baseMs = 1000): number {
  // 1s, 2s, 4s ...（加上最多 500ms 随机抖动）
  const delay = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return delay + jitter;
}

// ---------------------------------------------------------------------------
// callLLM
// ---------------------------------------------------------------------------

/**
 * 调用 LLM，返回文本内容。
 *
 * @param prompt - 用户 prompt
 * @param options - API 配置
 * @param systemPrompt - 系统 prompt（可选）
 * @returns 生成的文本
 */
export async function callLLM(
  prompt: string,
  options: CallLLMOptions,
  systemPrompt?: string,
): Promise<CallLLMResult> {
  const {
    baseUrl,
    apiKey,
    api,
    modelId,
    maxTokens,
    timeoutMs = 60_000,
    headers: extraHeaders,
    maxRetries = 2,
    onStream,
  } = options;

  const isAnthropic = api === "anthropic-messages";
  const url = isAnthropic
    ? `${baseUrl.replace(/\/+$/, "")}/v1/messages`
    : `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  // 构建请求头
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (isAnthropic) {
    reqHeaders["x-api-key"] = apiKey;
    reqHeaders["anthropic-version"] = "2023-06-01";
    // 移除可能冲突的 Authorization header
    delete reqHeaders["Authorization"];
  } else {
    reqHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  // 构建请求体
  let body: Record<string, unknown>;

  if (isAnthropic) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: prompt },
    ];
    body = {
      model: modelId,
      max_tokens: maxTokens ?? 4096,
      messages,
    };
    if (systemPrompt) {
      (body as Record<string, unknown>).system = systemPrompt;
    }
  } else {
    // openai-responses / openai-completions
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    body = {
      model: modelId,
      max_tokens: maxTokens ?? 4096,
      messages,
    };
  }

  // 如果提供了 onStream 回调，使用流式模式
  const useStreaming = !!onStream;
  if (useStreaming) {
    body.stream = true;
  }

  // 带重试的请求
  let lastError = "";
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = `LLM 请求超时（${timeoutMs}ms）：${url}`;
      } else {
        lastError = `LLM 请求失败：${err instanceof Error ? err.message : String(err)}`;
      }

      // 网络错误可重试
      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt);
        console.warn(`[callLLM] Attempt ${attempt + 1} failed: ${lastError}, retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
        retryCount++;
        continue;
      }
      throw new Error(lastError);
    } finally {
      clearTimeout(timeout);
    }

    // 检查是否需要重试（429 / 5xx）
    if (!response.ok) {
      const errorText = await response.text();
      lastError = `LLM API 错误 ${response.status}: ${errorText.slice(0, 500)}`;

      if (attempt < maxRetries && isRetryableStatus(response.status)) {
        const delay = backoffDelay(attempt);
        console.warn(`[callLLM] Attempt ${attempt + 1} got ${response.status}, retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
        retryCount++;
        continue;
      }
      throw new Error(lastError);
    }

    // 成功响应
    if (useStreaming && response.body) {
      const result = await parseSSEStream(response.body, isAnthropic, modelId, onStream!);
      return { ...result, retryCount };
    } else {
      const responseText = await response.text();
      const result = parseFullResponse(responseText, isAnthropic, modelId);
      return { ...result, retryCount };
    }
  }

  // 所有重试用尽
  throw new Error(lastError || "LLM 调用失败：所有重试用尽");
}

// ---------------------------------------------------------------------------
// SSE 流式解析
// ---------------------------------------------------------------------------

/** 解析 SSE 流，增量调用 onStream 回调 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  isAnthropic: boolean,
  modelId: string,
  onStream: (delta: string, fullText: string) => void,
): Promise<CallLLMResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let modelName = modelId;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按行处理 SSE 事件
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 最后一行可能不完整

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6); // 移除 "data: " 前缀
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          const delta = extractStreamDelta(event, isAnthropic);
          if (delta) {
            fullText += delta;
            onStream(delta, fullText);
          }

          // 提取 usage（在最后的事件中）
          const usage = extractStreamUsage(event, isAnthropic);
          if (usage) {
            inputTokens = usage.inputTokens;
            outputTokens = usage.outputTokens;
          }
          if (event.model) modelName = event.model;
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    content: fullText,
    model: modelName,
    usage: inputTokens !== undefined
      ? { inputTokens, outputTokens: outputTokens ?? 0 }
      : undefined,
  };
}

/** 从 SSE 事件中提取增量文本 */
function extractStreamDelta(event: any, isAnthropic: boolean): string {
  if (isAnthropic) {
    // Anthropic: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
    if (event.type === "content_block_delta" && event.delta?.text) {
      return event.delta.text as string;
    }
    return "";
  } else {
    // OpenAI: { choices: [{ delta: { content: "..." } }] }
    return event.choices?.[0]?.delta?.content ?? "";
  }
}

/** 从 SSE 事件中提取 usage */
function extractStreamUsage(
  event: any,
  isAnthropic: boolean,
): { inputTokens: number; outputTokens: number } | null {
  if (isAnthropic) {
    // Anthropic: { type: "message_delta", usage: { output_tokens: N } }
    if (event.type === "message_delta" && event.usage) {
      return {
        inputTokens: event.usage.input_tokens ?? 0,
        outputTokens: event.usage.output_tokens ?? 0,
      };
    }
  } else {
    // OpenAI: { usage: { prompt_tokens: N, completion_tokens: M } }
    if (event.usage) {
      return {
        inputTokens: event.usage.prompt_tokens ?? 0,
        outputTokens: event.usage.completion_tokens ?? 0,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 非流式响应解析
// ---------------------------------------------------------------------------

function parseFullResponse(
  responseText: string,
  isAnthropic: boolean,
  modelId: string,
): CallLLMResult {
  let json: any;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`LLM 响应 JSON 解析失败：${responseText.slice(0, 200)}`);
  }

  if (isAnthropic) {
    const text = json.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`Anthropic 响应格式异常：缺少 content[0].text`);
    }
    return {
      content: text,
      model: json.model ?? modelId,
      usage: json.usage
        ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
        : undefined,
    };
  } else {
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error(`OpenAI 响应格式异常：缺少 choices[0].message.content`);
    }
    return {
      content: text,
      model: json.model ?? modelId,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined,
    };
  }
}

/** sleep 工具函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// resolveLLMConfig
// ---------------------------------------------------------------------------

/**
 * 从 Extension 上下文中解析 LLM 配置。
 *
 * ctx.model 提供 model id、api type、baseUrl、maxTokens、headers。
 * ctx.modelRegistry 提供 API key（通过 getApiKeyAndHeaders）。
 *
 * 如果缺少必要信息返回 null。
 */
export async function resolveLLMConfig(ctx: {
  model?: {
    id: string;
    api: string;
    provider: string;
    baseUrl: string;
    maxTokens: number;
    headers?: Record<string, string>;
  };
  modelRegistry?: {
    getApiKeyAndHeaders(model: any): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; error?: string }>;
  };
}): Promise<CallLLMOptions | null> {
  const model = ctx.model;
  const registry = ctx.modelRegistry;

  if (!model) return null;
  if (!registry) return null;

  // 解析 API key
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return null;
  }

  return {
    baseUrl: model.baseUrl,
    apiKey: auth.apiKey,
    api: model.api,
    modelId: model.id,
    maxTokens: model.maxTokens,
    headers: {
      ...auth.headers,
      ...model.headers,
    },
  };
}
