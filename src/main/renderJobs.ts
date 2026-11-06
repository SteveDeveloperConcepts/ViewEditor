// Export jobs. One runs at a time; it keeps going when the user leaves the editor
// and reports progress to whichever window is listening.

import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BLANK_OVERLAY,
  buildRenderCommands,
  type ExportFormat,
  gifArgs,
  isSeekableExt,
  listOverlayFiles,
  mp3Args,
  planLayers,
  type OutputSpec,
  type RenderSource,
  type TimeWindow,
} from '../shared/render.ts';
import { newId } from '../shared/time.ts';
import type { ExportInfo, ID, ProjectDoc, RenderProgress } from '../shared/types.ts';
import { CancelledError, ffmpegCaps, runFfmpeg } from './ffmpeg.ts';
import type { LibraryStore } from './library.ts';
import { runRenderCommands } from './renderRun.ts';

interface Job {
  id: ID;
  projectId: ID;
  kind: 'export' | 'section';
  dir: string;
  /** Sections are written straight to where the user asked; exports go into the library. */
  savePath: string | null;
  format: ExportFormat;
  controller: AbortController;
  running: boolean;
}

const OVERLAY_NAME = /^(ov_\d+_\d+|blank)\.png$/;

export class RenderJobs {
  private readonly lib: LibraryStore;
  private readonly send: (p: RenderProgress) => void;
  private job: Job | null = null;
  private last: RenderProgress | null = null;

  constructor(lib: LibraryStore, send: (p: RenderProgress) => void) {
    this.lib = lib;
    this.send = send;
  }

  current(): RenderProgress | null {
    return this.last && (this.last.state === 'preparing' || this.last.state === 'rendering' || this.last.state === 'finishing') ? this.last : null;
  }

  private report(job: Job, patch: Partial<RenderProgress>): void {
    this.last = { jobId: job.id, projectId: job.projectId, kind: job.kind, state: 'rendering', progress: 0, ...patch };
    this.send(this.last);
  }

  async begin(projectId: ID, kind: 'export' | 'section', savePath: string | null, format: ExportFormat = 'mp4'): Promise<{ jobId: ID }> {
    if (this.job) throw new Error('Another video is still exporting. Wait for it to finish or cancel it first.');
    this.lib.project(projectId);
    const id = newId('job');
    const dir = join(this.lib.paths.tmpDir, id);
    await mkdir(dir, { recursive: true });
    this.job = { id, projectId, kind, dir, savePath, format, controller: new AbortController(), running: false };
    this.report(this.job, { state: 'preparing' });
    return { jobId: id };
  }

  private active(jobId: ID): Job {
    if (!this.job || this.job.id !== jobId) throw new Error('This render job is no longer active.');
    return this.job;
  }

  async putOverlay(jobId: ID, name: string, data: Uint8Array): Promise<void> {
    const job = this.active(jobId);
    if (!OVERLAY_NAME.test(name)) throw new Error('Unexpected overlay name.');
    await writeFile(join(job.dir, name), data);
  }

  /** Kicks the render off and returns straight away; progress arrives as events. */
  run(jobId: ID, payload: { doc: ProjectDoc; window: TimeWindow; spec: OutputSpec }): void {
    const job = this.active(jobId);
    if (job.running) return;
    job.running = true;
    void this.execute(job, payload).finally(async () => {
      if (this.job === job) this.job = null;
      await rm(job.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    });
  }

  private sources(): Record<ID, RenderSource> {
    const sources: Record<ID, RenderSource> = {};
    for (const a of this.lib.data.assets) {
      const raster = a.raster === 'ready';
      sources[a.id] = {
        path: this.lib.paths.assetRenderSource(a), kind: a.kind, hasAudio: a.hasAudio, audioChannels: a.audioChannels,
        hasAlpha: a.hasAlpha, isHdr: a.isHdr, colorMatrix: raster ? 'rgb' : a.colorMatrix, videoCodec: a.videoCodec,
        seekable: isSeekableExt(a.ext),
      };
    }
    return sources;
  }

  /** The sound of a stretch of a project as a small MP3, good enough for speech. Returns its path inside `dir`. */
  async speechFile(payload: { doc: ProjectDoc; window: TimeWindow; spec: OutputSpec }, dir: string): Promise<string> {
    const cmds = buildRenderCommands({ ...payload, sources: this.sources(), workDir: dir, outputPath: join(dir, 'out.mp4'), caps: await ffmpegCaps() });
    await runRenderCommands(cmds, { soundOnly: true });
    const out = join(dir, 'speech.mp3');
    await runFfmpeg(['-i', cmds.audio.out, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
    return out;
  }

  private async execute(job: Job, { doc, window, spec }: { doc: ProjectDoc; window: TimeWindow; spec: OutputSpec }): Promise<void> {
    try {
      if (window.end - window.start < 0.5 / spec.fps) throw new Error('There is nothing to export yet. Add something to the timeline first.');

      const sources = this.sources();

      // Every text picture the plan refers to must have arrived from the renderer. Sound needs none.
      const needed = job.format === 'mp3' ? [] : listOverlayFiles(planLayers(doc, window)).map((f) => f.file);
      if (needed.length) needed.push(BLANK_OVERLAY);
      for (const name of needed) {
        if (!(await stat(join(job.dir, name)).catch(() => null))) throw new Error('The text layers were not prepared. Try exporting again.');
      }

      const out = join(job.dir, 'out.mp4');
      const cmds = buildRenderCommands({ doc, window, spec, sources, workDir: job.dir, outputPath: out, caps: await ffmpegCaps() });
      await runRenderCommands(cmds, {
        signal: job.controller.signal,
        soundOnly: job.format === 'mp3',
        onProgress: (f) => this.report(job, { state: f >= 0.96 ? 'finishing' : 'rendering', progress: f }),
      });

      if (job.kind === 'section') {
        const target = job.savePath!;
        if (job.format === 'mp3') await runFfmpeg(mp3Args(cmds.audio.out, target), { signal: job.controller.signal });
        else if (job.format === 'gif') await runFfmpeg(gifArgs(out, target, spec.width), { signal: job.controller.signal });
        else {
          await rename(out, target).catch(async () => {
            await copyFile(out, target);
          });
        }
        this.report(job, { state: 'done', progress: 1, outputPath: target });
        return;
      }

      const dir = this.lib.paths.projectExports(job.projectId);
      await mkdir(dir, { recursive: true });
      const exportId = newId('exp');
      const file = `${exportId}.mp4`;
      await rename(out, join(dir, file)).catch(async () => {
        await copyFile(out, join(dir, file));
      });
      // Only the latest export of a project is kept.
      for (const old of await readdir(dir)) {
        if (old !== file) await rm(join(dir, old), { force: true }).catch(() => undefined);
      }
      const info: ExportInfo = {
        id: exportId, file, createdAt: Date.now(), width: spec.width, height: spec.height, fps: spec.fps,
        duration: cmds.duration, size: (await stat(join(dir, file))).size, presetLabel: spec.label,
      };
      this.lib.setLastExport(job.projectId, info);
      this.report(job, { state: 'done', progress: 1, outputPath: join(dir, file) });
    } catch (err) {
      if (err instanceof CancelledError || job.controller.signal.aborted) this.report(job, { state: 'cancelled', progress: 0 });
      else this.report(job, { state: 'error', progress: 0, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async cancel(): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    if (!job.running) {
      this.job = null;
      this.report(job, { state: 'cancelled', progress: 0 });
      await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Stops everything immediately (the app is quitting). */
  shutdown(): void {
    this.job?.controller.abort();
  }

  /** Path of the project's current exported MP4, or null if it has not been exported. */
  exportPath(projectId: ID): string | null {
    const meta = this.lib.project(projectId);
    return meta.lastExport ? join(this.lib.paths.projectExports(projectId), meta.lastExport.file) : null;
  }

  /** Writes a copy of the export in the requested format to `target`. */
  async saveAs(projectId: ID, format: 'mp4' | 'mp3' | 'gif', target: string): Promise<void> {
    const src = this.exportPath(projectId);
    if (!src) throw new Error('This project has not been exported yet.');
    if (format === 'mp4') await copyFile(src, target);
    else if (format === 'mp3') await runFfmpeg(mp3Args(src, target));
    else await runFfmpeg(gifArgs(src, target, this.lib.project(projectId).lastExport!.width));
  }
}
