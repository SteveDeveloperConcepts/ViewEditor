// fal.ai: one key reaches hundreds of models from many labs, including VEED's Fabric talking-video model.

import { readFile } from 'node:fs/promises';
import { modelsFromSchema, refResolver, type AiHint, type AiModel, type JsonSchema } from '../../shared/ai.ts';
import { call } from './http.ts';
import { findMediaUrls, type AiProvider, type PollResult } from './provider.ts';

const NAME = 'fal.ai';
const QUEUE = 'https://queue.fal.run';
const CATALOG = 'https://api.fal.ai/v1';
const STORAGE = 'https://rest.fal.ai';

const auth = (key: string): Record<string, string> => ({ Authorization: `Key ${key}` });

interface CatalogModel {
  endpoint_id: string;
  metadata?: { display_name?: string; description?: string; category?: string; status?: string };
  openapi?: { paths?: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }>; error?: unknown };
}

interface CatalogPage {
  models: CatalogModel[];
  next_cursor: string | null;
}

/** Finds the model's input in its OpenAPI document. */
export function inputSchemaOf(m: CatalogModel): { schema: JsonSchema; root: unknown } | null {
  const spec = m.openapi;
  for (const [path, item] of Object.entries(spec?.paths ?? {})) {
    if (path.includes('/requests/')) continue;
    const body = item.post?.requestBody?.content?.['application/json']?.schema;
    const resolved = refResolver(spec)(body);
    if (resolved) return { schema: resolved, root: spec };
  }
  return null;
}

export function modelsFromCatalog(entries: CatalogModel[], hint: AiHint): AiModel[] {
  const out: AiModel[] = [];
  for (const m of entries) {
    if (m.metadata?.status && m.metadata.status !== 'active') continue;
    const input = inputSchemaOf(m);
    if (!input) continue;
    out.push(
      ...modelsFromSchema(input.schema, refResolver(input.root), {
        provider: 'fal',
        id: m.endpoint_id,
        endpoint: m.endpoint_id,
        label: m.metadata?.display_name ?? m.endpoint_id,
        description: m.metadata?.description ?? '',
        hint,
      }),
    );
  }
  return out;
}

const CATEGORIES: AiHint[] = ['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image'];
/** With schemas included, the catalogue returns at most ten models per page. */
const PAGE = 10;
const PAGES_PER_CATEGORY = 4;

/** VEED's own models, always offered even if they rank low in the catalogue. */
const PINNED = ['veed/fabric-1.0', 'veed/lipsync'];

async function catalogPage(params: URLSearchParams, key: string | null): Promise<CatalogPage> {
  params.append('expand', 'openapi-3.0');
  return call<CatalogPage>(`${CATALOG}/models?${params}`, NAME, { headers: key ? auth(key) : {} });
}

export const fal: AiProvider = {
  id: 'fal',
  name: NAME,
  tagline: 'Kling, Seedance, Veo, MiniMax, WAN, Flux and VEED Fabric talking videos, on one key.',
  keyUrl: 'https://fal.ai/dashboard/keys',

  async verify(key) {
    await call(`${CATALOG}/models/pricing?endpoint_id=veed/fabric-1.0`, NAME, { headers: auth(key) });
    return null;
  },

  async listModels(key) {
    const models: AiModel[] = [];
    try {
      const pinned = new URLSearchParams();
      for (const id of PINNED) pinned.append('endpoint_id', id);
      const page = await catalogPage(pinned, key);
      models.push(...modelsFromCatalog(page.models.filter((m) => m.metadata?.category === 'image-to-video'), 'image-to-video'));
      models.push(...modelsFromCatalog(page.models.filter((m) => m.metadata?.category !== 'image-to-video'), 'video-to-video'));
      for (const category of CATEGORIES) {
        let cursor: string | null = null;
        for (let i = 0; i < PAGES_PER_CATEGORY; i++) {
          const q = new URLSearchParams({ category, status: 'active', limit: String(PAGE) });
          if (cursor) q.set('cursor', cursor);
          const next: CatalogPage = await catalogPage(q, key);
          models.push(...modelsFromCatalog(next.models, category));
          cursor = next.next_cursor;
          if (!cursor) break;
        }
      }
    } catch (err) {
      // A rate limit part-way through still leaves a usable list.
      if (!models.length) throw err;
    }
    const seen = new Set<string>();
    return models.filter((m) => !seen.has(m.key) && seen.add(m.key));
  },

  async upload(key, file, mime, name) {
    const started = await call<{ upload_url: string; file_url: string }>(`${STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3`, NAME, {
      headers: auth(key),
      json: { content_type: mime, file_name: name },
    });
    await call(started.upload_url, NAME, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: new Uint8Array(await readFile(file)),
      timeoutMs: 10 * 60_000,
    });
    return started.file_url;
  },

  async submit(key, model, inputs) {
    const res = await call<{ request_id: string; status_url: string; response_url: string; cancel_url: string }>(`${QUEUE}/${model.endpoint}`, NAME, {
      headers: auth(key),
      json: inputs,
    });
    return { id: res.request_id, statusUrl: res.status_url, resultUrl: res.response_url, cancelUrl: res.cancel_url };
  },

  async poll(key, remote): Promise<PollResult> {
    const status = await call<{ status: string; queue_position?: number; error?: string | null }>(remote.statusUrl!, NAME, { headers: auth(key) });
    if (status.status === 'IN_QUEUE') return { state: 'queued', position: status.queue_position ?? null };
    if (status.status === 'IN_PROGRESS') return { state: 'running', progress: null };
    if (status.error) return { state: 'failed', error: status.error };
    const result = await call(remote.resultUrl!, NAME, { headers: auth(key) });
    const urls = findMediaUrls(result);
    return urls.length ? { state: 'done', urls } : { state: 'failed', error: `${NAME} finished but sent no file back.` };
  },

  async cancel(key, remote) {
    if (remote.cancelUrl) await call(remote.cancelUrl, NAME, { method: 'PUT', headers: auth(key) });
  },

  async price(key, model) {
    const res = await call<{ prices?: { unit_price: number; unit: string; currency: string }[] }>(`${CATALOG}/models/pricing?endpoint_id=${encodeURIComponent(model.id)}`, NAME, { headers: auth(key) });
    const p = res.prices?.[0];
    if (!p) return null;
    const amount = new Intl.NumberFormat('en', { style: 'currency', currency: p.currency, maximumFractionDigits: 3 }).format(p.unit_price);
    return `${amount} per ${p.unit}`;
  },
};
