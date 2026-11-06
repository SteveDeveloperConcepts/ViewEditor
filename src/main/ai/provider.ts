import type { AiModel, AiProviderId, AiRemote } from '../../shared/ai.ts';

export type PollResult =
  | { state: 'queued'; position: number | null }
  | { state: 'running'; progress: number | null }
  | { state: 'done'; urls: string[] }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' };

/** Everything the app needs from an AI service. Adding a service means writing one of these. */
export interface AiProvider {
  id: AiProviderId;
  name: string;
  tagline: string;
  keyUrl: string;
  /** Checks the key against the service. Returns something useful to show about the account, if any. */
  verify(key: string): Promise<string | null>;
  /** The service's current models, read from its published schemas. */
  listModels(key: string | null): Promise<AiModel[]>;
  /** Puts a local file where the service can read it, and returns the address to pass in a request. */
  upload(key: string, file: string, mime: string, name: string): Promise<string>;
  submit(key: string, model: AiModel, inputs: Record<string, unknown>): Promise<AiRemote>;
  poll(key: string, remote: AiRemote): Promise<PollResult>;
  cancel(key: string, remote: AiRemote): Promise<void>;
  /** A short price description for a model, when the service publishes one. */
  price?(key: string, model: AiModel): Promise<string | null>;
}

/** Walks a result and collects the addresses of media files, whatever shape the model returned. */
export function findMediaUrls(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) into.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) findMediaUrls(v, into);
  } else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.url === 'string') into.push(v.url);
    else for (const key of ['video', 'videos', 'video_url', 'image', 'images', 'output', 'file', 'files']) if (key in v) findMediaUrls(v[key], into);
  }
  return into;
}
