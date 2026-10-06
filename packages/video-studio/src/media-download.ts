import { writeFileSync } from "node:fs";

const TRANSIENT_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ERR_STREAM_PREMATURE_CLOSE",
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function networkFailure(error: unknown, signal: AbortSignal): { retryable: boolean; label: string } {
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = value?.cause?.code ?? value?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return { retryable: true, label: code };
  if (value?.name === "TimeoutError" || (signal.aborted && signal.reason?.name === "TimeoutError")) {
    return { retryable: true, label: "TimeoutError" };
  }
  // Transport errors may contain a signed access URL; diagnostics never repeat their message.
  return { retryable: false, label: "不可恢复网络异常" };
}

/** Only retrieve an existing media URL. Generation submission and task polling are outside this component. */
export async function downloadMedia(input: {
  url: string;
  file: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const signal = AbortSignal.timeout(300_000);
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await fetchImpl(input.url, { method: "GET", signal });
      if (!response.ok) {
        if (response.body) await response.body.cancel();
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < attempts) {
          input.log?.(`媒体取回 HTTP ${response.status}，重试 GET ${attempt + 1}/${attempts}；不提交生成任务`);
          await sleep(attempt * 1000);
          continue;
        }
        throw new Error(`媒体下载失败 HTTP ${response.status}`);
      }
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (error instanceof Error && /^媒体下载失败 HTTP \d+$/.test(error.message)) throw error;
      const failure = networkFailure(error, signal);
      if (!failure.retryable || attempt === attempts) {
        throw new Error(`媒体下载网络失败（${failure.label}，GET 请求 ${attempt} 次）；成功生成任务回执保持不变`);
      }
      input.log?.(`媒体取回 ${failure.label}，重试 GET ${attempt + 1}/${attempts}；不提交生成任务`);
      await sleep(attempt * 1000);
      continue;
    }
    // Nothing is written until the complete response is available. Filesystem failures are not retried as network failures.
    writeFileSync(input.file, Buffer.from(bytes));
    return input.file;
  }
  throw new Error("媒体取回重试已耗尽");
}
