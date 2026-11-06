// Talking to AI services: JSON requests, uploads and downloads, with errors a person can act on.

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** Tests point the app at a stand-in server by mapping real hosts to local ones. */
function hostOverrides(): Record<string, string> {
  try {
    return JSON.parse(process.env.VIEWEDITOR_AI_HOSTS ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function resolveUrl(url: string): string {
  for (const [from, to] of Object.entries(hostOverrides())) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

export class ProviderError extends Error {
  readonly status: number;
  /** Worth trying the same call again later. */
  readonly transient: boolean;

  constructor(message: string, status: number, transient = false) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.transient = transient;
  }
}

/** Finds the human-readable part of an error body. Services all shape these differently. */
function messageFrom(body: unknown): string | null {
  if (typeof body === 'string') return body.trim().slice(0, 400) || null;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.detail)) {
    const first = b.detail[0] as { msg?: unknown; loc?: unknown[] } | undefined;
    if (first && typeof first.msg === 'string') {
      const where = Array.isArray(first.loc) ? first.loc.filter((p) => p !== 'body').join('.') : '';
      return where ? `${where}: ${first.msg}` : first.msg;
    }
  }
  for (const key of ['detail', 'message', 'error', 'title']) {
    const value = b[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
    if (value && typeof value === 'object') {
      const nested = messageFrom(value);
      if (nested) return nested;
    }
  }
  return null;
}

function failure(status: number, service: string, body: unknown): ProviderError {
  const said = messageFrom(body);
  if (status === 401) return new ProviderError(`${service} did not accept this API key. Check it under AI connections.`, status);
  if (status === 402) return new ProviderError(said ?? `Your ${service} account has run out of credit.`, status);
  if (status === 403) return new ProviderError(said ?? `${service} refused this request. Your account may not have access to this model.`, status);
  if (status === 429) return new ProviderError(said ?? `${service} is rate limiting this account. Try again shortly.`, status, true);
  if (status >= 500) return new ProviderError(said ?? `${service} had a problem (${status}).`, status, true);
  return new ProviderError(said ?? `${service} returned an error (${status}).`, status);
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  signal?: AbortSignal;
  /** Allow a slow service a while, but never hang forever. */
  timeoutMs?: number;
}

async function send(url: string, service: string, opts: CallOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    return await fetch(resolveUrl(url), {
      method: opts.method ?? (opts.json !== undefined || opts.body ? 'POST' : 'GET'),
      headers: { ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ProviderError(`Could not reach ${service}. Check your internet connection.`, 0, true);
  }
}

/** Calls an API and returns its JSON. Throws a ProviderError for anything but success. */
export async function call<T = unknown>(url: string, service: string, opts: CallOptions = {}): Promise<T> {
  const res = await send(url, service, opts);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text for the error message.
  }
  if (!res.ok) throw failure(res.status, service, parsed);
  return parsed as T;
}

/** Saves a remote file. Returns the type the server says it is. */
export async function download(url: string, file: string, service: string, signal?: AbortSignal): Promise<string> {
  const res = await send(url, service, { signal, timeoutMs: 10 * 60_000 });
  if (!res.ok || !res.body) throw failure(res.status, service, null);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file), { signal });
  return res.headers.get('content-type') ?? '';
}
