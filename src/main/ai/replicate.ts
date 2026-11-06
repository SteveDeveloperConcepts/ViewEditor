// Replicate: a large marketplace of models, listed by collection.

import { readFile } from 'node:fs/promises';
import { modelsFromSchema, refResolver, type AiHint, type AiModel, type JsonSchema } from '../../shared/ai.ts';
import { call } from './http.ts';
import { findMediaUrls, type AiProvider, type PollResult } from './provider.ts';

const NAME = 'Replicate';
const API = 'https://api.replicate.com/v1';

const auth = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

const COLLECTIONS: [string, AiHint][] = [
  ['text-to-video', 'text-to-video'],
  ['image-to-video', 'image-to-video'],
  ['video-editing', 'video-to-video'],
  ['lipsync', 'lipsync'],
  ['text-to-image', 'text-to-image'],
];

/** Listing a model costs one request, so each collection is limited to its first few. */
const PER_COLLECTION = 14;

interface ListedModel {
  owner: string;
  name: string;
  description?: string;
  latest_version?: { id?: string; openapi_schema?: unknown } | null;
}

export function modelsFromListing(m: ListedModel, hint: AiHint): AiModel[] {
  const spec = m.latest_version?.openapi_schema;
  const deref = refResolver(spec);
  const schema: JsonSchema | undefined = deref((spec as { components?: { schemas?: { Input?: unknown } } } | undefined)?.components?.schemas?.Input);
  if (!schema) return [];
  const id = `${m.owner}/${m.name}`;
  return modelsFromSchema(schema, deref, { provider: 'replicate', id, endpoint: `${id}@${m.latest_version?.id ?? ''}`, label: id, description: m.description ?? '', hint });
}

interface Prediction {
  id: string;
  status: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

export const replicate: AiProvider = {
  id: 'replicate',
  name: NAME,
  tagline: 'Thousands of community and official models, billed by the second.',
  keyUrl: 'https://replicate.com/account/api-tokens',

  async verify(key) {
    const account = await call<{ username?: string }>(`${API}/account`, NAME, { headers: auth(key) });
    return account.username ?? null;
  },

  async listModels(key) {
    if (!key) return [];
    const models: AiModel[] = [];
    try {
      for (const [slug, hint] of COLLECTIONS) {
        const collection = await call<{ models?: ListedModel[] }>(`${API}/collections/${slug}`, NAME, { headers: auth(key) });
        for (const listed of (collection.models ?? []).slice(0, PER_COLLECTION)) {
          const full = listed.latest_version?.openapi_schema
            ? listed
            : await call<ListedModel>(`${API}/models/${listed.owner}/${listed.name}`, NAME, { headers: auth(key) });
          models.push(...modelsFromListing(full, hint));
        }
      }
    } catch (err) {
      if (!models.length) throw err;
    }
    const seen = new Set<string>();
    return models.filter((m) => !seen.has(m.key) && seen.add(m.key));
  },

  async upload(key, file, mime, name) {
    const form = new FormData();
    form.append('content', new Blob([new Uint8Array(await readFile(file))], { type: mime }), name);
    form.append('type', mime);
    form.append('filename', name);
    const res = await call<{ urls?: { get?: string } }>(`${API}/files`, NAME, { headers: auth(key), body: form, timeoutMs: 10 * 60_000 });
    if (!res.urls?.get) throw new Error('Replicate did not say where the upload went.');
    return res.urls.get;
  },

  async submit(key, model, inputs) {
    const [id, version] = model.endpoint.split('@');
    // Official models are addressed by name. Everything else needs the exact version.
    const byName = await call<Prediction>(`${API}/models/${id}/predictions`, NAME, { headers: auth(key), json: { input: inputs } }).catch(async (err: { status?: number }) => {
      if (!version || (err.status !== 404 && err.status !== 422)) throw err;
      return call<Prediction>(`${API}/predictions`, NAME, { headers: auth(key), json: { version, input: inputs } });
    });
    return { id: byName.id, statusUrl: byName.urls?.get ?? `${API}/predictions/${byName.id}`, cancelUrl: byName.urls?.cancel ?? `${API}/predictions/${byName.id}/cancel` };
  },

  async poll(key, remote): Promise<PollResult> {
    const p = await call<Prediction>(remote.statusUrl!, NAME, { headers: auth(key) });
    switch (p.status) {
      case 'starting':
        return { state: 'queued', position: null };
      case 'processing':
        return { state: 'running', progress: null };
      case 'succeeded': {
        const urls = findMediaUrls(p.output);
        return urls.length ? { state: 'done', urls } : { state: 'failed', error: `${NAME} finished but sent no file back.` };
      }
      case 'canceled':
        return { state: 'cancelled' };
      default:
        return { state: 'failed', error: p.error ?? `${NAME} could not finish this.` };
    }
  },

  async cancel(key, remote) {
    if (remote.cancelUrl) await call(remote.cancelUrl, NAME, { method: 'POST', headers: auth(key) });
  },
};
