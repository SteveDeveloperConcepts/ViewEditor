// The model lists. Providers are asked at most once a day; a saved copy covers outages and rate limits,
// and a list shipped with the app covers the very first run.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiModel, AiProviderId, AiTask } from '../../shared/ai.ts';
import type { KeyStore } from './keys.ts';
import type { AiProvider } from './provider.ts';

const DAY = 24 * 60 * 60 * 1000;

interface Saved {
  fetchedAt: number;
  models: AiModel[];
}

export class AiCatalog {
  private readonly dir: string;
  private readonly providers: AiProvider[];
  private readonly keys: KeyStore;
  private readonly bundled: Partial<Record<AiProviderId, AiModel[]>>;
  private readonly memory = new Map<AiProviderId, Saved>();
  private readonly loading = new Map<AiProviderId, Promise<AiModel[]>>();

  constructor(dir: string, providers: AiProvider[], keys: KeyStore, bundled: Partial<Record<AiProviderId, AiModel[]>> = {}) {
    this.dir = dir;
    this.providers = providers;
    this.keys = keys;
    this.bundled = bundled;
  }

  private file(id: AiProviderId): string {
    return join(this.dir, `ai-models-${id}.json`);
  }

  private async saved(id: AiProviderId): Promise<Saved | null> {
    const known = this.memory.get(id);
    if (known) return known;
    try {
      const s = JSON.parse(await readFile(this.file(id), 'utf8')) as Saved;
      if (!Array.isArray(s.models)) return null;
      this.memory.set(id, s);
      return s;
    } catch {
      return null;
    }
  }

  private async fetchFresh(provider: AiProvider, fallback: AiModel[]): Promise<AiModel[]> {
    try {
      const models = await provider.listModels(this.keys.get(provider.id));
      if (!models.length) return fallback;
      const saved: Saved = { fetchedAt: Date.now(), models };
      this.memory.set(provider.id, saved);
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(provider.id), JSON.stringify(saved));
      return models;
    } catch {
      return fallback;
    }
  }

  /** The models of one provider, refreshed when the saved list is old or a refresh is asked for. */
  private async forProvider(provider: AiProvider, refresh: boolean): Promise<AiModel[]> {
    const saved = await this.saved(provider.id);
    const fallback = saved?.models ?? this.bundled[provider.id] ?? [];
    if (saved && !refresh && Date.now() - saved.fetchedAt < DAY) return saved.models;
    const running = this.loading.get(provider.id);
    if (running) return running;
    const job = this.fetchFresh(provider, fallback).finally(() => this.loading.delete(provider.id));
    this.loading.set(provider.id, job);
    return job;
  }

  /** Models from every connected service, optionally for one task. */
  async models(task?: AiTask, refresh = false): Promise<AiModel[]> {
    const connected = this.providers.filter((p) => this.keys.has(p.id));
    const lists = await Promise.all(connected.map((p) => this.forProvider(p, refresh)));
    const all = lists.flat();
    return task ? all.filter((m) => m.task === task) : all;
  }

  async find(key: string): Promise<AiModel | null> {
    return (await this.models()).find((m) => m.key === key) ?? null;
  }
}
