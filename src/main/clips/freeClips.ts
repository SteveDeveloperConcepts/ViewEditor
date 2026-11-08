// Searching the stock video libraries a person has connected, and bringing a clip into Media.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CLIP_SIZE, fileFor, interleave, type ClipProgress, type ClipRequest, type ClipResults, type ClipSearch, type ClipServiceId, type ClipServiceStatus, type FreeClip } from '../../shared/clips.ts';
import { safeFileName } from '../../shared/constants.ts';
import { newId } from '../../shared/time.ts';
import type { Asset } from '../../shared/types.ts';
import { download, ProviderError } from '../ai/http.ts';
import type { KeyStore } from '../ai/keys.ts';
import type { AssetManager } from '../assets.ts';
import type { LibraryStore } from '../library.ts';
import type { ClipPage, ClipQuery, ClipService } from './service.ts';

const PER_PAGE = 20;

/** Pixabay requires searches to be kept this long, and it saves Pexels' hourly limit too. */
const KEEP_SEARCHES_MS = 24 * 60 * 60 * 1000;

/** Raise this when what is stored changes, so old searches are not read back wrongly. */
const STORED_VERSION = 1;

const PROGRESS_EVERY_MS = 100;

export interface FreeClipsOptions {
  lib: LibraryStore;
  assets: AssetManager;
  keys: KeyStore<ClipServiceId>;
  services: ClipService[];
  /** Where searches are kept between runs of the app. */
  searchDir: string;
  onProgress: (p: ClipProgress) => void;
  now?: () => number;
}

interface Download {
  controller: AbortController;
  done: Promise<Asset | null>;
}

const refusedKey = (err: unknown): boolean => err instanceof ProviderError && (err.status === 401 || err.status === 403 || (err.status === 400 && /key/i.test(err.message)));

export class FreeClips {
  private readonly o: FreeClipsOptions;
  /** What searches have shown. The page names a clip, so it never decides what gets downloaded. */
  private readonly seen = new Map<string, FreeClip>();
  private readonly downloads = new Map<string, Download>();

  constructor(options: FreeClipsOptions) {
    this.o = options;
  }

  private get now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private service(id: ClipServiceId): ClipService {
    const service = this.o.services.find((s) => s.id === id);
    if (!service) throw new Error('Unknown clip service.');
    return service;
  }

  private status({ id, name, tagline, homeUrl, keyUrl, licenseUrl, terms }: ClipService): ClipServiceStatus {
    return { id, name, tagline, homeUrl, keyUrl, licenseUrl, terms, connected: this.o.keys.has(id) };
  }

  services(): ClipServiceStatus[] {
    return this.o.services.map((s) => this.status(s));
  }

  /** Tests a key against the service and stores it if it works. */
  async connect(id: ClipServiceId, key: string): Promise<ClipServiceStatus> {
    const service = this.service(id);
    const clean = String(key ?? '').trim();
    try {
      await service.verify(clean);
    } catch (err) {
      throw refusedKey(err) ? new Error(`${service.name} did not accept this key. Check that you copied all of it.`) : err;
    }
    await this.o.keys.set(id, clean);
    return this.status(service);
  }

  async disconnect(id: ClipServiceId): Promise<void> {
    await this.o.keys.remove(id);
  }

  async search(input: ClipSearch): Promise<ClipResults> {
    const q: ClipQuery = {
      query: String(input.query ?? '').trim().replace(/\s+/g, ' '),
      shape: input.shape,
      page: Math.max(1, Math.floor(input.page) || 1),
      perPage: PER_PAGE,
    };
    const connected = this.o.services.filter((s) => this.o.keys.has(s.id));
    if (!connected.length) throw new Error('Connect Pexels or Pixabay first.');
    const answers = await Promise.allSettled(connected.map((s) => this.page(s, q)));
    const pages = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []));
    const problems = answers.flatMap((a) => (a.status === 'rejected' ? [a.reason instanceof Error ? a.reason.message : String(a.reason)] : []));
    if (!pages.length) throw new Error(problems[0]);
    const clips = interleave(pages.map((p) => p.clips));
    for (const clip of clips) this.seen.set(clip.key, clip);
    return { clips, hasMore: pages.some((p) => p.hasMore), problems };
  }

  /** One service's answer, from what is kept if it asked this recently. */
  private async page(service: ClipService, q: ClipQuery): Promise<ClipPage> {
    const name = createHash('sha256').update(JSON.stringify([STORED_VERSION, service.id, q.query.toLowerCase(), q.shape, q.page, q.perPage])).digest('hex');
    const file = join(this.o.searchDir, `${name.slice(0, 32)}.json`);
    const kept = await readFile(file, 'utf8').then((text) => JSON.parse(text) as { savedAt: number; page: ClipPage }, () => null);
    if (kept && this.now - kept.savedAt < KEEP_SEARCHES_MS) return kept.page;

    const key = this.o.keys.get(service.id);
    if (!key) throw new Error(`${service.name} is not connected.`);
    try {
      const page = await service.search(key, q);
      await mkdir(this.o.searchDir, { recursive: true });
      // Not being able to keep a search is no reason to lose its results.
      await writeFile(file, JSON.stringify({ savedAt: this.now, page })).catch(() => undefined);
      return page;
    } catch (err) {
      throw refusedKey(err) ? new Error(`${service.name} no longer accepts your key. Connect it again under Manage.`) : err;
    }
  }

  /** Removes searches that have passed their time. */
  async tidySearches(): Promise<void> {
    for (const entry of await readdir(this.o.searchDir).catch(() => [] as string[])) {
      const file = join(this.o.searchDir, entry);
      const info = await stat(file).catch(() => null);
      if (info && this.now - info.mtimeMs >= KEEP_SEARCHES_MS) await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Where to read the still or the small copy of a clip that a search has shown. */
  address(key: string, what: string): string | null {
    const clip = this.seen.get(key);
    if (what === 'picture') return clip?.picture || null;
    return what === 'preview' ? (clip?.preview ?? null) : null;
  }

  /** The clip in Media, fetching it first if it is not there yet. Null when the download was cancelled. */
  async add({ key, fit }: ClipRequest): Promise<Asset | null> {
    const known = this.o.lib.data.assets.find((a) => a.credit?.key === key);
    if (known) return known;
    const running = this.downloads.get(key);
    if (running) return running.done;
    const clip = this.seen.get(key);
    if (!clip) throw new Error('This clip is no longer in your results. Search again and add it from there.');
    const controller = new AbortController();
    const done = this.fetch(clip, fit?.width > 0 && fit?.height > 0 ? fit : DEFAULT_CLIP_SIZE, controller.signal).finally(() => this.downloads.delete(key));
    this.downloads.set(key, { controller, done });
    return done;
  }

  private async fetch(clip: FreeClip, fit: ClipRequest['fit'], signal: AbortSignal): Promise<Asset | null> {
    const service = this.service(clip.service);
    const dir = join(this.o.lib.paths.tmpDir, newId('clp'));
    await mkdir(dir, { recursive: true });
    let reported = 0;
    const onProgress = (done: number, total: number | null): void => {
      if (this.now - reported < PROGRESS_EVERY_MS) return;
      reported = this.now;
      this.o.onProgress({ key: clip.key, fraction: total ? done / total : null });
    };
    try {
      const file = join(dir, 'clip.mp4');
      await download(fileFor(clip.files, fit).url, file, service.name, signal, onProgress);
      const imported = await this.o.assets.importFiles([file], {
        scope: 'workspace',
        move: true,
        source: 'stock',
        names: [`${safeFileName(clip.title)}.mp4`],
        credit: { key: clip.key, service: service.name, creator: clip.creator, creatorUrl: clip.creatorUrl, pageUrl: clip.pageUrl, licenseUrl: service.licenseUrl },
      });
      const asset = imported.assets[0];
      if (!asset) throw new Error(imported.rejected[0]?.reason ?? 'The clip could not be added to Media.');
      return asset;
    } catch (err) {
      if (signal.aborted) return null;
      if (err instanceof ProviderError) {
        if (err.status < 400 || err.status >= 500 || err.status === 429) throw err;
        // The address has gone stale, so the kept search that gave it has to go too.
        await rm(this.o.searchDir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(`${service.name} no longer offers this file. Search again and try once more.`);
      }
      // A connection that drops part of the way through surfaces as a TypeError or a timeout, not as a message for people.
      if (err instanceof Error && err.name !== 'Error') throw new Error(`The download from ${service.name} stopped. Check your internet connection and try again.`);
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    }
  }

  cancel(key: string): void {
    this.downloads.get(key)?.controller.abort();
  }

  /** Stops what is running, because the app is closing. */
  shutdown(): void {
    for (const d of this.downloads.values()) d.controller.abort();
  }
}
