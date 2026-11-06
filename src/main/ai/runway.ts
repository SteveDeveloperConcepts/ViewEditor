// Runway's API: its own Gen and Aleph models plus many others, all behind one credit balance.
// Requests differ per model, so the model list comes from the OpenAPI document Runway publishes.

import { readFile } from 'node:fs/promises';
import { modelsFromSchema, refResolver, type AiHint, type AiModel, type JsonSchema } from '../../shared/ai.ts';
import { call } from './http.ts';
import type { AiProvider, PollResult } from './provider.ts';

const NAME = 'Runway';
const API = 'https://api.dev.runwayml.com';
const SPEC = 'https://docs.dev.runwayml.com/openapi.json';
const VERSION = '2024-11-06';

const headers = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}`, 'X-Runway-Version': VERSION });

const ENDPOINTS: [string, AiHint][] = [
  ['/v1/text_to_video', 'text-to-video'],
  ['/v1/image_to_video', 'image-to-video'],
  ['/v1/video_to_video', 'video-to-video'],
  ['/v1/text_to_image', 'text-to-image'],
];

/** Display names, for the identifiers that do not read well on their own. */
function labelFor(id: string): string {
  const named: Record<string, string> = { aleph2: 'Aleph 2.0', 'gen4.5': 'Gen-4.5', gen4_turbo: 'Gen-4 Turbo', gen4_image: 'Gen-4 Image', gen4_image_turbo: 'Gen-4 Image Turbo' };
  if (named[id]) return named[id];
  return id
    .replace(/_/g, ' ')
    .replace(/(^|\s)([a-z])/g, (_m, s: string, c: string) => s + c.toUpperCase())
    .replace(/(\d)(\s)(\d)/g, '$1.$3');
}

/**
 * Settings Runway documents but a schema cannot express. Edit modes change a video in place,
 * so they keep its shape and length rather than taking new ones.
 */
function adjustForEditing(model: AiModel, schema: JsonSchema, deref: (n: unknown) => JsonSchema | undefined): AiModel {
  if (model.task !== 'edit-video') return model;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const modes = deref(props.mode)?.enum;
  if (!Array.isArray(modes) || !modes.includes('edit')) return model;
  const auto = model.duration?.values?.includes('auto') || deref(props.duration)?.anyOf !== undefined;
  return { ...model, aspect: null, duration: null, fixed: { ...model.fixed, mode: 'edit', ...(auto ? { duration: 'auto' } : {}) } };
}

export function modelsFromSpec(spec: { paths: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }> }): AiModel[] {
  const deref = refResolver(spec);
  const out: AiModel[] = [];
  for (const [path, hint] of ENDPOINTS) {
    const root = deref(spec.paths[path]?.post?.requestBody?.content?.['application/json']?.schema);
    const variants = (root?.oneOf ?? root?.anyOf ?? [root]) as unknown[];
    for (const raw of variants) {
      const schema = deref(raw);
      const props = schema?.properties as Record<string, { const?: unknown; enum?: unknown[] }> | undefined;
      const modelField = deref(props?.model);
      const id = modelField?.const ?? (modelField?.enum as unknown[] | undefined)?.[0];
      if (!schema || typeof id !== 'string') continue;
      const models = modelsFromSchema(schema, deref, { provider: 'runway', id, endpoint: path, label: labelFor(id), description: '', hint });
      for (const m of models) out.push(adjustForEditing({ ...m, fixed: { ...m.fixed, model: id } }, schema, deref));
    }
  }
  return out;
}

export const runway: AiProvider = {
  id: 'runway',
  name: NAME,
  tagline: 'Gen-4.5 and Aleph video editing, plus Kling, Seedance, Veo and more, on Runway credits.',
  keyUrl: 'https://dev.runway.com',

  async verify(key) {
    const org = await call<{ creditBalance?: number }>(`${API}/v1/organization`, NAME, { headers: headers(key) });
    return typeof org.creditBalance === 'number' ? `${org.creditBalance.toLocaleString('en')} credits` : null;
  },

  async listModels() {
    return modelsFromSpec(await call(SPEC, NAME));
  },

  async upload(key, file, mime, name) {
    const started = await call<{ uploadUrl: string; fields: Record<string, string>; runwayUri: string }>(`${API}/v1/uploads`, NAME, {
      headers: headers(key),
      json: { filename: name, type: 'ephemeral' },
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(started.fields)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(await readFile(file))], { type: mime }), name);
    await call(started.uploadUrl, NAME, { body: form, timeoutMs: 10 * 60_000 });
    return started.runwayUri;
  },

  async submit(key, model, inputs) {
    const task = await call<{ id: string }>(`${API}${model.endpoint}`, NAME, { headers: headers(key), json: inputs });
    return { id: task.id };
  },

  async poll(key, remote): Promise<PollResult> {
    const task = await call<{ status: string; progress?: number; output?: string[]; failure?: string; failureCode?: string }>(`${API}/v1/tasks/${remote.id}`, NAME, { headers: headers(key) });
    switch (task.status) {
      case 'PENDING':
      case 'THROTTLED':
        return { state: 'queued', position: null };
      case 'RUNNING':
        return { state: 'running', progress: task.progress ?? null };
      case 'SUCCEEDED':
        return task.output?.length ? { state: 'done', urls: task.output } : { state: 'failed', error: `${NAME} finished but sent no file back.` };
      case 'CANCELLED':
        return { state: 'cancelled' };
      default:
        return {
          state: 'failed',
          error: task.failureCode?.startsWith('SAFETY') || task.failureCode?.startsWith('INPUT_PREPROCESSING.SAFETY')
            ? 'Runway’s content rules blocked this. Try a different prompt or picture.'
            : (task.failure ?? `${NAME} could not finish this.`),
        };
    }
  },

  async cancel(key, remote) {
    await call(`${API}/v1/tasks/${remote.id}`, NAME, { method: 'DELETE', headers: headers(key) });
  },
};
