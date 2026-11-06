// Refreshes the model lists shipped with the app. They are only a fallback for the first run or an
// outage; the running app reads the live lists. Usage: npm run ai:catalog
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiHint, AiModel } from '../src/shared/ai.ts';
import { modelsFromCatalog } from '../src/main/ai/fal.ts';
import { modelsFromSpec } from '../src/main/ai/runway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'main', 'ai');
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function json<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'vieweditor-catalog-update' } });
    if (res.ok) return (await res.json()) as T;
    if (res.status !== 429) throw new Error(`${res.status} ${url}`);
    console.log('  rate limited, waiting');
    await wait(20_000);
  }
  throw new Error(`still rate limited: ${url}`);
}

function summarise(name: string, models: AiModel[]): void {
  const count: Record<string, number> = {};
  for (const m of models) count[m.task] = (count[m.task] ?? 0) + 1;
  console.log(name, models.length, JSON.stringify(count));
}

const runway = modelsFromSpec(await json('https://docs.dev.runwayml.com/openapi.json'));
writeFileSync(join(out, 'snapshot-runway.json'), JSON.stringify(runway));
summarise('runway', runway);

const fal: AiModel[] = [];
const hints: AiHint[] = ['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image'];
for (const category of hints) {
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const q = new URLSearchParams({ category, status: 'active', limit: '10' });
    q.append('expand', 'openapi-3.0');
    if (cursor) q.set('cursor', cursor);
    const body: { models: never[]; next_cursor: string | null } = await json(`https://api.fal.ai/v1/models?${q}`);
    fal.push(...modelsFromCatalog(body.models, category));
    cursor = body.next_cursor;
    if (!cursor) break;
    await wait(7000);
  }
}
const pinned: { models: { metadata?: { category?: string } }[] } = await json('https://api.fal.ai/v1/models?endpoint_id=veed/fabric-1.0&endpoint_id=veed/lipsync&expand=openapi-3.0');
for (const m of pinned.models) fal.push(...modelsFromCatalog([m as never], m.metadata?.category === 'image-to-video' ? 'image-to-video' : 'video-to-video'));
const seen = new Set<string>();
const unique = fal.filter((m) => !seen.has(m.key) && seen.add(m.key));
writeFileSync(join(out, 'snapshot-fal.json'), JSON.stringify(unique));
summarise('fal', unique);
