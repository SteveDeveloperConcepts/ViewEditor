// Generation jobs. A job prepares its inputs, hands them to a service, follows it until the result is
// ready and brings that into the library. Generation costs money and can take many minutes, so a job
// is saved the moment the service accepts it and carries on after the app restarts.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ALL_MEDIA_EXTS, extOf } from '../../shared/constants.ts';
import { buildInputs, isActive, type AiInputUrls, type AiJob, type AiModel, type AiProviderId, type AiRemote, type AiRequest } from '../../shared/ai.ts';
import { newId } from '../../shared/time.ts';
import type { ID } from '../../shared/types.ts';
import type { AssetManager } from '../assets.ts';
import type { LibraryStore } from '../library.ts';
import type { AiCatalog } from './catalog.ts';
import { download, ProviderError } from './http.ts';
import type { KeyStore } from './keys.ts';
import { prepareAudio, prepareImage, prepareVideo } from './media.ts';
import type { AiProvider } from './provider.ts';

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};

const GIVE_UP_AFTER = 90 * 60 * 1000;
/** How many polls in a row may fail for reasons that usually pass, such as a dropped connection. */
const MAX_MISSES = 40;

function shortName(job: Pick<AiJob, 'prompt' | 'task'>, fallback?: string): string {
  const text = (fallback ?? job.prompt).replace(/[\r\n]+/g, ' ').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  if (!text) return job.task === 'text-to-image' ? 'AI image' : 'AI video';
  return text.length > 48 ? `${text.slice(0, 47).trim()}…` : text;
}

export interface AiJobsOptions {
  lib: LibraryStore;
  assets: AssetManager;
  keys: KeyStore;
  catalog: AiCatalog;
  providers: AiProvider[];
  /** First wait between checks. Lengthens while a job runs. */
  pollMs?: number;
}

export class AiJobs {
  private readonly o: AiJobsOptions;
  private readonly controllers = new Map<ID, AbortController>();
  private readonly settled = new Map<ID, Promise<void>>();

  constructor(options: AiJobsOptions) {
    this.o = options;
  }

  private provider(id: AiProviderId): AiProvider {
    const p = this.o.providers.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown AI service: ${id}`);
    return p;
  }

  private update(id: ID, patch: Partial<AiJob>): void {
    this.o.lib.updateAiJob(id, patch);
  }

  private fail(id: ID, err: unknown): void {
    this.update(id, { state: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: Date.now() });
  }

  /** Resolves when the job has finished one way or another. Used by tests and on quit. */
  whenSettled(id: ID): Promise<void> {
    return this.settled.get(id) ?? Promise.resolve();
  }

  private track(id: ID, work: Promise<void>): void {
    const done = work.finally(() => {
      this.controllers.delete(id);
      this.settled.delete(id);
    });
    this.settled.set(id, done);
  }

  /** Starts a job and returns at once; its progress shows up in the library. */
  async generate(request: AiRequest): Promise<AiJob> {
    const model = await this.o.catalog.find(request.modelKey);
    if (!model) throw new Error('This model is no longer available. Pick another one.');
    const key = this.o.keys.get(model.provider);
    if (!key) throw new Error(`Connect ${this.provider(model.provider).name} under AI connections first.`);

    const prompt = request.choices.prompt?.trim() ?? '';
    const job: AiJob = {
      id: newId('job'),
      provider: model.provider,
      modelKey: model.key,
      modelLabel: model.label,
      task: model.task,
      prompt,
      name: shortName({ prompt, task: model.task }, request.name),
      state: 'preparing',
      queuePosition: null,
      progress: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      remote: null,
      request,
      assetId: null,
      applied: request.placement.kind === 'none',
    };
    this.o.lib.addAiJob(job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.track(job.id, this.run(job, model, key, controller.signal));
    return job;
  }

  private async run(job: AiJob, model: AiModel, key: string, signal: AbortSignal): Promise<void> {
    const dir = join(this.o.lib.paths.tmpDir, job.id);
    const provider = this.provider(model.provider);
    let remote: AiRemote;
    try {
      await mkdir(dir, { recursive: true });
      const { lib } = this.o;
      const { image, video, audio } = job.request;
      const files = [
        image && model.image ? ['image', await prepareImage(lib, image, dir)] : null,
        video && model.video ? ['video', await prepareVideo(lib, video, dir)] : null,
        audio && model.audio ? ['audio', await prepareAudio(lib, audio, dir)] : null,
      ].filter((f) => f !== null) as [keyof AiInputUrls, { file: string; mime: string; name: string }][];
      if (signal.aborted) return;

      const urls: AiInputUrls = {};
      if (files.length) this.update(job.id, { state: 'uploading' });
      for (const [role, f] of files) urls[role] = await provider.upload(key, f.file, f.mime, f.name);
      if (signal.aborted) return;

      remote = await provider.submit(key, model, buildInputs(model, job.request.choices, urls));
      this.update(job.id, { state: 'queued', remote });
      // From here on the service is working, and billing, for this job: write that down straight away.
      await lib.flush();
    } catch (err) {
      if (!signal.aborted) this.fail(job.id, err);
      return;
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    }
    await this.follow(job.id, provider, key, remote, signal);
  }

  /** Waits for the service, then brings the result in. */
  private async follow(id: ID, provider: AiProvider, key: string, remote: AiRemote, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let wait = this.o.pollMs ?? 4000;
    let misses = 0;
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, wait));
      if (signal.aborted) return;
      wait = Math.min(wait * 1.25, Math.max(10_000, this.o.pollMs ?? 0));
      if (Date.now() - started > GIVE_UP_AFTER) {
        this.fail(id, `${provider.name} has not finished after 90 minutes. If it completes, the result will be in your ${provider.name} account.`);
        return;
      }
      try {
        const result = await provider.poll(key, remote);
        misses = 0;
        if (signal.aborted) return;
        if (result.state === 'queued') this.update(id, { state: 'queued', queuePosition: result.position });
        else if (result.state === 'running') this.update(id, { state: 'running', queuePosition: null, progress: result.progress });
        else if (result.state === 'failed') return this.fail(id, result.error);
        else if (result.state === 'cancelled') return this.update(id, { state: 'cancelled', finishedAt: Date.now() });
        else return await this.collect(id, provider, result.urls[0], signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ProviderError && err.transient && ++misses < MAX_MISSES) continue;
        return this.fail(id, err);
      }
    }
  }

  private async collect(id: ID, provider: AiProvider, url: string, signal: AbortSignal): Promise<void> {
    const job = this.o.lib.data.aiJobs?.find((j) => j.id === id);
    if (!job) return;
    this.update(id, { state: 'downloading', progress: null, queuePosition: null });
    const dir = join(this.o.lib.paths.tmpDir, id);
    await mkdir(dir, { recursive: true });
    try {
      const file = join(dir, 'result.bin');
      const type = await download(url, file, provider.name, signal);
      const fromUrl = extOf(new URL(url).pathname);
      const ext = ALL_MEDIA_EXTS.includes(fromUrl) ? fromUrl : (MIME_EXT[type.split(';')[0].trim()] ?? (job.task === 'text-to-image' ? 'png' : 'mp4'));
      const { scope, projectId } = job.request.target;
      const imported = await this.o.assets.importFiles([file], {
        scope,
        projectId,
        move: true,
        source: 'ai',
        names: [`${job.name}.${ext}`],
        origin: { provider: provider.name, model: job.modelLabel, prompt: job.prompt },
      });
      const asset = imported.assets[0];
      if (!asset) throw new Error(imported.rejected[0]?.reason ?? 'The result could not be added to your library.');
      this.update(id, { state: 'done', assetId: asset.id, finishedAt: Date.now() });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    }
  }

  /** Picks up where things stood when the app last closed. */
  resume(): void {
    for (const job of this.o.lib.data.aiJobs ?? []) {
      if (!isActive(job)) continue;
      const key = this.o.keys.get(job.provider);
      if (!job.remote) {
        this.fail(job.id, 'The app closed before this reached the service, so it was not started.');
      } else if (!key) {
        this.fail(job.id, `${this.provider(job.provider).name} is no longer connected, so this result could not be collected.`);
      } else {
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        this.track(job.id, this.follow(job.id, this.provider(job.provider), key, job.remote, controller.signal));
      }
    }
  }

  /** Stops waiting, and asks the service to stop too. Work already done may still be billed. */
  async cancel(id: ID): Promise<void> {
    const job = this.o.lib.data.aiJobs?.find((j) => j.id === id);
    if (!job || !isActive(job)) return;
    this.controllers.get(id)?.abort();
    const key = this.o.keys.get(job.provider);
    if (job.remote && key) await this.provider(job.provider).cancel(key, job.remote).catch(() => undefined);
    this.update(id, { state: 'cancelled', finishedAt: Date.now() });
  }

  dismiss(id: ID): void {
    const job = this.o.lib.data.aiJobs?.find((j) => j.id === id);
    if (job && !isActive(job)) this.o.lib.removeAiJob(id);
  }

  markApplied(id: ID): void {
    this.update(id, { applied: true });
  }

  /** Stops following jobs. Saved jobs resume at the next start. */
  shutdown(): void {
    for (const c of this.controllers.values()) c.abort();
  }
}
