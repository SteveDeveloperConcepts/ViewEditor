// Screen and camera recording. The renderer captures with MediaRecorder and streams the data here
// in chunks; this side picks the capture source, writes the file and turns it into a library asset.

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, desktopCapturer, globalShortcut, session, type DesktopCapturerSource } from 'electron';
import { newId } from '../shared/time.ts';
import type { Asset, CaptureSource, ID } from '../shared/types.ts';
import type { AssetManager, ImportOptions } from './assets.ts';
import { runFfmpeg, runFfprobe } from './ffmpeg.ts';
import type { LibraryStore } from './library.ts';

export const STOP_SHORTCUT = 'CommandOrControl+Shift+F9';

interface Recording {
  file: string;
  dir: string;
  stream: WriteStream;
}

export class Recorder {
  private readonly lib: LibraryStore;
  private readonly assets: AssetManager;
  private readonly window: () => BrowserWindow | null;
  private sources: DesktopCapturerSource[] = [];
  private chosen: { id: string; systemAudio: boolean } | null = null;
  private readonly recordings = new Map<ID, Recording>();

  constructor(lib: LibraryStore, assets: AssetManager, window: () => BrowserWindow | null) {
    this.lib = lib;
    this.assets = assets;
    this.window = window;
  }

  /** Answers the page's getDisplayMedia() with the source picked in our own source list. */
  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      const source = this.sources.find((s) => s.id === this.chosen?.id);
      if (!source) {
        // Nothing was chosen: refuse the capture.
        (callback as (streams: null) => void)(null);
        return;
      }
      // System audio capture ("loopback") exists on Windows only.
      callback(this.chosen?.systemAudio && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    });
  }

  async listSources(): Promise<CaptureSource[]> {
    this.sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 250 } });
    // The app minimises itself while recording, so its own window would only record as a frozen picture.
    const own = this.window()?.getMediaSourceId();
    return this.sources
      .filter((s) => !s.thumbnail.isEmpty() && s.id !== own)
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const),
        thumbnail: s.thumbnail.toDataURL(),
      }));
  }

  prepare(sourceId: string, systemAudio: boolean): void {
    this.chosen = { id: sourceId, systemAudio };
  }

  async begin(): Promise<{ recId: ID }> {
    const recId = newId('rec');
    const dir = join(this.lib.paths.tmpDir, recId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'capture.webm');
    this.recordings.set(recId, { file, dir, stream: createWriteStream(file) });
    return { recId };
  }

  chunk(recId: ID, data: Uint8Array): Promise<void> {
    const rec = this.recordings.get(recId);
    if (!rec) return Promise.resolve();
    return new Promise((resolve, reject) => rec.stream.write(data, (err) => (err ? reject(err) : resolve())));
  }

  async finish(recId: ID, name: string, target: ImportOptions): Promise<Asset> {
    const rec = this.recordings.get(recId);
    if (!rec) throw new Error('This recording is no longer available.');
    this.recordings.delete(recId);
    await new Promise<void>((resolve) => rec.stream.end(resolve));
    try {
      // MediaRecorder output has no duration or seek index; rewriting the container adds both.
      let file = rec.file;
      let ext = 'webm';
      try {
        const probe = await runFfprobe(rec.file);
        const video = probe.streams?.find((s) => s.codec_type === 'video');
        if (video?.codec_name === 'h264') {
          file = join(rec.dir, 'fixed.mp4');
          ext = 'mp4';
          await runFfmpeg(['-i', rec.file, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file]);
        } else {
          file = join(rec.dir, 'fixed.webm');
          await runFfmpeg(['-i', rec.file, '-c', 'copy', file]);
        }
      } catch {
        file = rec.file;
        ext = 'webm';
      }
      const result = await this.assets.importFiles([file], { ...target, move: true, source: 'recording', names: [`${name}.${ext}`] });
      if (!result.assets.length) throw new Error(result.rejected[0]?.reason ?? 'The recording could not be saved.');
      return result.assets[0];
    } finally {
      await rm(rec.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    }
  }

  async discard(recId: ID): Promise<void> {
    const rec = this.recordings.get(recId);
    if (!rec) return;
    this.recordings.delete(recId);
    await new Promise<void>((resolve) => rec.stream.end(resolve));
    await rm(rec.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
  }

  /** While recording, the window can be tucked away and a global shortcut brings it back and stops the capture. */
  setActive(active: boolean, minimise: boolean): void {
    const win = this.window();
    globalShortcut.unregister(STOP_SHORTCUT);
    if (active) {
      globalShortcut.register(STOP_SHORTCUT, () => {
        const w = this.window();
        if (!w) return;
        if (w.isMinimized()) w.restore();
        w.focus();
        w.webContents.send('recorder:stop', null);
      });
      if (minimise) win?.minimize();
    } else if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      this.chosen = null;
    }
  }
}
