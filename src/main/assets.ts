// Importing media into the library and producing everything the editor needs from it:
// poster frames, timeline filmstrips, waveforms and (when Chromium cannot play the original) preview proxies.

import { constants as fsConstants, existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ALL_MEDIA_EXTS, extOf, fileTitle } from '../shared/constants.ts';
import { HDR_TO_SDR } from '../shared/render.ts';
import { newId } from '../shared/time.ts';
import type { Asset, AssetCredit, AssetOrigin, AssetSource, ID, ImportResult } from '../shared/types.ts';
import { ffmpegCaps, runFfmpeg } from './ffmpeg.ts';
import type { LibraryStore } from './library.ts';
import { probeMedia, type ProbeInfo } from './probe.ts';

export interface ImportOptions {
  scope: 'workspace' | 'project';
  projectId?: ID | null;
  source?: AssetSource;
  /** Move the files into the library instead of copying (used for files the app itself produced). */
  move?: boolean;
  /** Display names, when they differ from the file names on disk. */
  names?: string[];
  /** For AI-generated media: where it came from. */
  origin?: AssetOrigin;
  /** For free clips: who made it and where it came from. */
  credit?: AssetCredit;
  /** For sound taken out of a video: which video. */
  extractedFrom?: ID;
}

export interface ImportProgress {
  done: number;
  total: number;
  name: string;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: even(w * s), h: even(h * s) };
}

/** Whether Chromium is expected to play the original file directly. */
function previewRule(info: ProbeInfo, ext: string): 'native' | 'proxy' | 'check' {
  if (info.kind === 'audio') return 'check';
  if (info.kind !== 'video') return 'native';
  if (ext === 'gif') return 'proxy';
  const v = info.videoCodec ?? '';
  const a = info.audioCodec;
  const mp4ish = ext === 'mp4' || ext === 'm4v' || ext === 'mov';
  const webmish = ext === 'webm' || ext === 'mkv';
  if (mp4ish && v === 'h264' && (info.pixFmt === 'yuv420p' || info.pixFmt === 'yuvj420p') && (!a || a === 'aac' || a === 'mp3')) return 'native';
  if (webmish && (v === 'vp8' || v === 'vp9' || v === 'av1') && (!a || a === 'opus' || a === 'vorbis')) return 'native';
  if (info.hasAlpha) return 'proxy';
  // HEVC, H.264 in Matroska and a few others play on some machines only: let the editor try before transcoding.
  if ((mp4ish || webmish) && (v === 'h264' || v === 'hevc' || v === 'av1' || v === 'vp9')) return 'check';
  return 'proxy';
}

class JobQueue {
  private running = 0;
  private readonly waiting: (() => Promise<void>)[] = [];
  private readonly idlers: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(job: () => Promise<void>): void {
    this.waiting.push(job);
    this.pump();
  }

  /** Resolves once nothing is running or queued. */
  idle(): Promise<void> {
    if (!this.running && !this.waiting.length) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
    if (!this.running && !this.waiting.length) {
      for (const done of this.idlers.splice(0)) done();
    }
  }
}

interface Inflight {
  controller: AbortController;
  started: boolean;
  done: Promise<void>;
}

export class AssetManager {
  private readonly lib: LibraryStore;
  private readonly jobs = new JobQueue(2);
  private readonly inflight = new Map<ID, Set<Inflight>>();
  onImportProgress: (p: ImportProgress | null) => void = () => undefined;

  constructor(lib: LibraryStore) {
    this.lib = lib;
    lib.beforeAssetRemoval = (ids) => this.cancelJobs(ids);
  }

  /** Resolves when all background processing (posters, waveforms, proxies) has finished. */
  whenIdle(): Promise<void> {
    return this.jobs.idle();
  }

  /** Queues background work on one asset. The work is skipped if the asset is deleted first. */
  private schedule(id: ID, work: (signal: AbortSignal) => Promise<void>): void {
    let finish!: () => void;
    const entry: Inflight = { controller: new AbortController(), started: false, done: new Promise<void>((r) => (finish = r)) };
    const set = this.inflight.get(id) ?? new Set<Inflight>();
    set.add(entry);
    this.inflight.set(id, set);
    this.jobs.push(async () => {
      entry.started = true;
      try {
        if (!entry.controller.signal.aborted && this.lib.asset(id)) await work(entry.controller.signal);
      } finally {
        set.delete(entry);
        if (!set.size) this.inflight.delete(id);
        finish();
      }
    });
  }

  /** Stops background work on the given assets and waits until ffmpeg has let go of their files. */
  private async cancelJobs(ids: ID[]): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      for (const entry of this.inflight.get(id) ?? []) {
        entry.controller.abort();
        if (entry.started) waits.push(entry.done);
      }
    }
    await Promise.all(waits);
  }

  /** Re-queues work that was interrupted the last time the app closed. */
  resume(): void {
    for (const a of this.lib.data.assets) {
      if (a.kind === 'video' && !a.hasThumb) this.schedule(a.id, (s) => this.makeVideoPictures(a.id, s));
      if (a.hasAudio && !a.hasWave) this.schedule(a.id, (s) => this.makeWave(a.id, s));
      if (a.proxy === 'pending') this.schedule(a.id, (s) => this.makeProxy(a.id, s));
    }
  }

  async importFiles(files: string[], opts: ImportOptions): Promise<ImportResult> {
    const result: ImportResult = { assets: [], rejected: [] };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = opts.names?.[i] ?? basename(file);
      this.onImportProgress({ done: i, total: files.length, name });
      try {
        result.assets.push(await this.importOne(file, name, opts));
      } catch (err) {
        result.rejected.push({ name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    this.onImportProgress(null);
    return result;
  }

  private async importOne(file: string, name: string, opts: ImportOptions): Promise<Asset> {
    const st = await stat(file).catch(() => null);
    if (!st) throw new Error('The file could not be found.');
    if (st.isDirectory()) throw new Error('Folders cannot be added. Open the folder and select the files inside it.');
    const ext = extOf(name);
    if (!ALL_MEDIA_EXTS.includes(ext)) throw new Error(ext ? `.${ext} files are not supported.` : 'This file type is not supported.');
    if (st.size === 0) throw new Error('The file is empty.');
    // Adding the same file again gives what is already in Media, not a second copy of it.
    const known = opts.move ? undefined : this.lib.data.assets.find((a) => a.source === 'upload' && a.name === name && a.size === st.size);
    if (known) return known;

    const id = newId('ast');
    const paths = this.lib.paths;
    const dir = paths.assetDir(id);
    await mkdir(dir, { recursive: true });
    const original = paths.assetOriginal({ id, ext });
    try {
      if (opts.move) {
        await rename(file, original).catch(async () => {
          await copyFile(file, original);
          await unlink(file).catch(() => undefined);
        });
      } else {
        // COPYFILE_FICLONE makes this instant on file systems that support cloning (APFS) and a plain copy elsewhere.
        await copyFile(file, original, fsConstants.COPYFILE_FICLONE);
      }
      const info = await probeMedia(original, ext).catch(() => {
        throw new Error('This file could not be read. It may be damaged or use an unsupported codec.');
      });
      const rule = previewRule(info, ext);
      const asset: Asset = {
        id, kind: info.kind, name, ext, size: st.size, createdAt: Date.now(),
        source: opts.source ?? 'upload', origin: opts.origin ?? null, credit: opts.credit ?? null, extractedFrom: opts.extractedFrom ?? null, scope: opts.scope, projectId: opts.scope === 'project' ? (opts.projectId ?? null) : null,
        duration: info.duration, width: info.width, height: info.height, fps: info.fps,
        hasAudio: info.hasAudio, audioChannels: info.audioChannels, hasAlpha: info.hasAlpha, isHdr: info.isHdr,
        videoCodec: info.videoCodec, audioCodec: info.audioCodec, colorMatrix: info.colorMatrix,
        hasThumb: false, strip: null, hasWave: false,
        proxy: rule === 'proxy' ? 'pending' : 'none', proxyExt: null,
        previewChecked: rule === 'native' && info.kind !== 'image',
        raster: 'none',
      };
      this.lib.addAsset(asset);
      if (asset.kind === 'video') this.schedule(id, (s) => this.makeVideoPictures(id, s));
      if (asset.hasAudio) this.schedule(id, (s) => this.makeWave(id, s));
      if (asset.proxy === 'pending') this.schedule(id, (s) => this.makeProxy(id, s));
      return asset;
    } catch (err) {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Takes the sound out of a video as an audio file of its own, in Media. It is stored losslessly, because
   * it will be encoded again on export. Any delay before the sound starts is kept, so it stays in sync.
   */
  async extractAudio(id: ID): Promise<Asset> {
    const video = this.lib.asset(id);
    if (!video) throw new Error('This media is no longer in your library.');
    if (video.kind !== 'video' || !video.hasAudio) throw new Error('This file has no sound to extract.');
    const existing = this.lib.data.assets.find((a) => a.extractedFrom === id);
    if (existing) return existing;
    const dir = join(this.lib.paths.tmpDir, newId('snd'));
    await mkdir(dir, { recursive: true });
    try {
      const file = join(dir, 'sound.flac');
      await runFfmpeg(['-i', this.lib.paths.assetOriginal(video), '-map', '0:a:0', '-af', 'aresample=first_pts=0', '-c:a', 'flac', file]);
      const result = await this.importFiles([file], { scope: 'workspace', move: true, source: 'extracted', names: [`${fileTitle(video.name)} sound.flac`], extractedFrom: id });
      if (!result.assets.length) throw new Error(result.rejected[0]?.reason ?? 'The sound could not be saved.');
      return result.assets[0];
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    }
  }

  /** Called by the editor when it finds it cannot play an original. */
  requestProxy(id: ID): void {
    const a = this.lib.asset(id);
    if (!a || a.kind === 'image' || a.proxy === 'pending' || a.proxy === 'ready') return;
    this.lib.updateAsset(id, { proxy: 'pending' });
    this.schedule(id, (s) => this.makeProxy(id, s));
  }

  markPreviewChecked(id: ID): void {
    this.lib.updateAsset(id, { previewChecked: true });
  }

  /**
   * Images are decoded by the renderer (Chromium reads every supported format and applies EXIF rotation).
   * It hands back the true display size, a poster, and — when ffmpeg cannot be trusted with the original — a PNG copy.
   */
  async putImageDerivatives(id: ID, data: { width: number; height: number; thumb: Uint8Array; raster: Uint8Array | null }): Promise<void> {
    const a = this.lib.asset(id);
    if (!a || a.kind !== 'image') return;
    const paths = this.lib.paths;
    await writeFile(paths.assetThumb(a), data.thumb);
    if (data.raster) await writeFile(paths.assetRaster(id), data.raster);
    this.lib.updateAsset(id, {
      width: Math.round(data.width), height: Math.round(data.height), hasThumb: true, previewChecked: true,
      ...(data.raster ? { raster: 'ready' as const, colorMatrix: 'rgb' as const, hasAlpha: true } : {}),
    });
  }

  async remove(ids: ID[]): Promise<void> {
    await this.lib.removeAssets(ids);
  }

  // ------------------------------------------------------------ derived files

  private decoderArgs(a: Asset): string[] {
    if (a.hasAlpha && a.videoCodec === 'vp9') return ['-c:v', 'libvpx-vp9'];
    if (a.hasAlpha && a.videoCodec === 'vp8') return ['-c:v', 'libvpx'];
    return [];
  }

  private async sdrPrefix(a: Asset): Promise<string> {
    return a.isHdr && (await ffmpegCaps()).tonemap ? `${HDR_TO_SDR},` : '';
  }

  private async makeVideoPictures(id: ID, signal: AbortSignal): Promise<void> {
    const a = this.lib.asset(id);
    if (!a || a.kind !== 'video') return;
    const paths = this.lib.paths;
    const src = paths.assetOriginal(a);
    const sdr = await this.sdrPrefix(a);

    // Poster. Seeking can come up empty in files without regular keyframes, so fall back to the first frame.
    const poster = fitWithin(a.width, a.height, 480);
    const thumb = paths.assetThumb(a);
    const grab = (seek: string[]): Promise<void> =>
      runFfmpeg(
        [...this.decoderArgs(a), ...seek, '-i', src, '-frames:v', '1', '-vf', `${sdr}scale=${poster.w}:${poster.h}`, '-q:v', '4', thumb],
        { signal },
      ).catch(() => undefined);
    await grab(['-ss', (a.duration > 2 ? 1 : a.duration * 0.3).toFixed(3)]);
    if (!existsSync(thumb) && !signal.aborted) await grab([]);
    if (signal.aborted) return;
    if (existsSync(thumb)) this.lib.updateAsset(id, { hasThumb: true });

    // Filmstrip: evenly spaced frames in one sprite. Long files only decode keyframes to stay fast.
    const tileH = 54;
    const tileW = even((a.width / a.height) * tileH);
    const count = Math.max(1, Math.min(80, Math.ceil(a.duration / 1.5)));
    const strip = paths.assetStrip(id);
    await runFfmpeg(
      [
        ...(a.duration > 120 ? ['-skip_frame', 'nokey'] : []), ...this.decoderArgs(a), '-i', src, '-an',
        '-vf', `${sdr}fps=${(count / a.duration).toFixed(6)},scale=${tileW}:${tileH},tile=${count}x1`,
        '-frames:v', '1', '-q:v', '5', strip,
      ],
      { signal },
    ).catch(() => undefined);
    if (!signal.aborted && existsSync(strip)) this.lib.updateAsset(id, { strip: { count, tileW, tileH } });
  }

  private async makeWave(id: ID, signal: AbortSignal): Promise<void> {
    const a = this.lib.asset(id);
    if (!a || !a.hasAudio) return;
    const width = Math.max(600, Math.min(6000, Math.round(a.duration * 40)));
    const wave = this.lib.paths.assetWave(id);
    await runFfmpeg(
      [
        '-i', this.lib.paths.assetOriginal(a),
        '-filter_complex', `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${width}x96:colors=white:scale=sqrt[w]`,
        '-map', '[w]', '-frames:v', '1', wave,
      ],
      { signal },
    ).catch(() => undefined);
    if (!signal.aborted && existsSync(wave)) this.lib.updateAsset(id, { hasWave: true });
  }

  private async makeProxy(id: ID, signal: AbortSignal): Promise<void> {
    const a = this.lib.asset(id);
    if (!a || a.proxy !== 'pending') return;
    const paths = this.lib.paths;
    const src = paths.assetOriginal(a);
    try {
      let proxyExt: Asset['proxyExt'];
      if (a.kind === 'audio') {
        proxyExt = 'm4a';
        await runFfmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', paths.assetProxy({ id, proxyExt })], { signal });
      } else {
        const size = fitWithin(a.width, a.height, 1280);
        const sdr = await this.sdrPrefix(a);
        const audio = a.hasAudio ? ['-map', '0:a:0'] : [];
        if (a.hasAlpha) {
          // VP9 with an alpha plane is the one transparent format Chromium plays.
          proxyExt = 'webm';
          await runFfmpeg(
            [
              ...this.decoderArgs(a), '-i', src, '-map', '0:v:0', ...audio,
              '-vf', `scale=${size.w}:${size.h},setsar=1`,
              '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
              '-b:v', '0', '-crf', '34', '-auto-alt-ref', '0', '-g', '30',
              ...(a.hasAudio ? ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2'] : []),
              paths.assetProxy({ id, proxyExt }),
            ],
            { signal },
          );
        } else {
          proxyExt = 'mp4';
          await runFfmpeg(
            [
              '-i', src, '-map', '0:v:0', ...audio,
              '-vf', `${sdr}scale=${size.w}:${size.h},setsar=1,format=yuv420p`,
              // A short keyframe interval keeps scrubbing responsive.
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '30',
              ...(a.hasAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
              '-movflags', '+faststart', paths.assetProxy({ id, proxyExt }),
            ],
            { signal },
          );
        }
      }
      this.lib.updateAsset(id, { proxy: 'ready', proxyExt, previewChecked: true });
    } catch {
      if (!signal.aborted) this.lib.updateAsset(id, { proxy: 'failed', previewChecked: true });
    }
  }
}
