/**
 * P1.2 — the shared transport for both local APIs.
 *
 * Both the Riot Client and the League Client expose an HTTPS server on loopback with a
 * self-signed certificate and HTTP Basic auth (`riot:<lockfile password>`). Certificate
 * verification is therefore disabled — but only for these connections, constructed here.
 * `NODE_TLS_REJECT_UNAUTHORIZED` is never touched, because that would disable verification for
 * every outbound request in the process, including the ones carrying the Riot API key.
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { Lockfile } from "./lockfile.js";
import { redact } from "../log/redact.js";

export interface LocalApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: T | null;
}

/**
 * A structured error from a local API. Riot's local endpoints answer with a consistent
 * `{ errorCode, httpStatus, message }` shape, and the message is often the only thing that
 * distinguishes a real failure from a normal transient state — "RSO is not yet initialized"
 * being the one that matters most.
 */
export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly path: string
  ) {
    super(message);
    this.name = "LocalApiError";
  }

  /**
   * The client is up but its RSO subsystem has not finished starting. Not a failure — poll
   * again. Mistaking this for an error is what produced a false negative in EXP-1.
   */
  get isNotInitialised(): boolean {
    return this.status === 404 && /not yet initialized/i.test(this.message);
  }

  /**
   * The route is absent at runtime. EXP-2 established that the client's own OpenAPI spec is a
   * SUPERSET of what is implemented — a fully documented path can still answer this.
   */
  get isRouteMissing(): boolean {
    return this.status === 404 && /^not found$/i.test(this.message.trim());
  }
}

export interface CallOptions {
  body?: unknown;
  timeoutMs?: number;
  /** Retries for transport errors only — never for an HTTP status. */
  retries?: number;
  retryDelayMs?: number;
}

/** One request against a local API. Resolves for any HTTP status; rejects only on transport failure. */
export function callLocalApi<T = unknown>(
  lock: Lockfile,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  { body, timeoutMs = 15_000 }: CallOptions = {}
): Promise<LocalApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const requestFn = lock.protocol === "https" ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        host: "127.0.0.1",
        port: lock.port,
        path,
        method,
        // Self-signed loopback certificate — scoped to this request, never process-wide.
        rejectUnauthorized: false,
        headers: {
          Authorization: "Basic " + Buffer.from(`riot:${lock.password}`).toString("base64"),
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: T | null = null;
          try {
            json = JSON.parse(text) as T;
          } catch {
            /* many endpoints answer with an empty body */
          }
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, text, json });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", (err) => reject(new Error(redact(`${method} ${path}: ${err.message}`))));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Like `callLocalApi`, but throws a `LocalApiError` for non-2xx. */
export async function callLocalApiOrThrow<T = unknown>(
  lock: Lockfile,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  options: CallOptions = {}
): Promise<T> {
  const res = await callLocalApi<T>(lock, method, path, options);
  if (!res.ok) {
    const shape = res.json as { message?: string; errorCode?: string } | null;
    throw new LocalApiError(
      shape?.message ?? res.text.slice(0, 200) ?? `HTTP ${res.status}`,
      res.status,
      shape?.errorCode ?? null,
      path
    );
  }
  return res.json as T;
}

/** Retry wrapper for transport failures — a client that is still starting refuses connections. */
export async function callWithRetry<T = unknown>(
  lock: Lockfile,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  { retries = 3, retryDelayMs = 500, ...options }: CallOptions = {}
): Promise<LocalApiResponse<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callLocalApi<T>(lock, method, path, options);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Linear backoff is enough here: the client takes a second or two to open its port.
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
