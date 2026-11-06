// Getting library media ready to send: cut to the part being used, in a format every service accepts.
// Originals are never uploaded as they are, so a clip's unused footage stays on the computer.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiMediaRef } from '../../shared/ai.ts';
import { HDR_TO_SDR, isSeekableExt } from '../../shared/render.ts';
import type { Asset } from '../../shared/types.ts';
import { ffmpegCaps, runFfmpeg } from '../ffmpeg.ts';
import type { LibraryStore } from '../library.ts';

export interface PreparedFile {
  file: string;
  mime: string;
  name: string;
}

const MAX_VIDEO_SIDE = 1920;
const MAX_IMAGE_SIDE = 2048;
const MAX_FPS = 30;
/** The strictest upload limit among the connected services. */
const MAX_UPLOAD_BYTES = 190 * 1024 * 1024;

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

function fit(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: even(w * s), h: even(h * s) };
}

function requireAsset(lib: LibraryStore, ref: AiMediaRef): Asset {
  const asset = lib.asset(ref.assetId);
  if (!asset) throw new Error('This media is no longer in your library.');
  return asset;
}

async function sdr(a: Asset): Promise<string> {
  return a.isHdr && (await ffmpegCaps()).tonemap ? `${HDR_TO_SDR},` : '';
}

async function stillFromVideo(lib: LibraryStore, a: Asset, at: number, out: string): Promise<void> {
  const src = lib.paths.assetOriginal(a);
  const size = fit(a.width, a.height, MAX_IMAGE_SIDE);
  const filter = `${await sdr(a)}scale=${size.w}:${size.h}`;
  const tail = ['-frames:v', '1', '-vf', filter, '-q:v', '2', out];
  const time = Math.max(0, at).toFixed(3);
  if (isSeekableExt(a.ext)) await runFfmpeg(['-ss', time, '-i', src, ...tail]);
  else await runFfmpeg(['-i', src, '-ss', time, ...tail]);
  // Asking for the very last moment can land after the final frame.
  if (!existsSync(out)) await runFfmpeg(['-sseof', '-0.5', '-i', src, ...tail]);
  if (!existsSync(out)) throw new Error('Could not take a picture from this clip.');
}

/** A still picture: an image from the library, or one frame of a video. */
export async function prepareImage(lib: LibraryStore, ref: AiMediaRef, dir: string): Promise<PreparedFile> {
  const a = requireAsset(lib, ref);
  if (a.kind === 'audio') throw new Error('This needs a picture, not audio.');
  if (a.kind === 'video') {
    const name = 'frame.jpg';
    await stillFromVideo(lib, a, ref.frameAt ?? 0, join(dir, name));
    return { file: join(dir, name), mime: 'image/jpeg', name };
  }
  const size = fit(a.width, a.height, MAX_IMAGE_SIDE);
  const alpha = a.hasAlpha;
  const name = alpha ? 'image.png' : 'image.jpg';
  await runFfmpeg(['-i', lib.paths.assetRenderSource(a), '-frames:v', '1', '-vf', `scale=${size.w}:${size.h}`, ...(alpha ? [] : ['-q:v', '2']), join(dir, name)]);
  return { file: join(dir, name), mime: alpha ? 'image/png' : 'image/jpeg', name };
}

/** The stretch of a video being worked on, as a plain H.264 MP4. */
export async function prepareVideo(lib: LibraryStore, ref: AiMediaRef, dir: string): Promise<PreparedFile> {
  const a = requireAsset(lib, ref);
  if (a.kind !== 'video') throw new Error('This needs a video.');
  const start = ref.start ?? 0;
  const length = Math.max(0.1, (ref.end ?? a.duration) - start);
  const size = fit(a.width, a.height, MAX_VIDEO_SIDE);
  const fps = Math.min(MAX_FPS, a.fps || MAX_FPS);
  const filters = `${await sdr(a)}scale=${size.w}:${size.h},fps=${fps},format=yuv420p`;
  const seekable = isSeekableExt(a.ext);
  const name = 'clip.mp4';
  const out = join(dir, name);
  await runFfmpeg([
    ...(seekable ? ['-ss', start.toFixed(3), '-t', length.toFixed(3)] : []),
    '-i', lib.paths.assetOriginal(a),
    ...(seekable ? [] : ['-ss', start.toFixed(3), '-t', length.toFixed(3)]),
    '-vf', filters,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    ...(a.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart', out,
  ]);
  if ((await stat(out)).size > MAX_UPLOAD_BYTES) throw new Error('This clip is too large to send. Split it into shorter pieces first.');
  return { file: out, mime: 'video/mp4', name };
}

/** Sound as MP3, taken from an audio file or from a video's soundtrack. */
export async function prepareAudio(lib: LibraryStore, ref: AiMediaRef, dir: string): Promise<PreparedFile> {
  const a = requireAsset(lib, ref);
  if (!a.hasAudio) throw new Error('This file has no sound.');
  const name = 'audio.mp3';
  const range = ref.start !== undefined ? ['-ss', ref.start.toFixed(3), ...(ref.end !== undefined ? ['-t', (ref.end - ref.start).toFixed(3)] : [])] : [];
  await runFfmpeg([...range, '-i', lib.paths.assetOriginal(a), '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', join(dir, name)]);
  return { file: join(dir, name), mime: 'audio/mpeg', name };
}
