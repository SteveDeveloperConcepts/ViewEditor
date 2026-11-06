import { spawn } from 'node:child_process';
import { sep } from 'node:path';
import { ffmpegPath, ffprobePath } from 'ffmpeg-ffprobe-static';
import type { FfmpegCaps } from '../shared/render.ts';

/** Binaries cannot run from inside the asar archive; the packaged app keeps them unpacked next to it. */
function unpacked(p: string | null, name: string): string {
  if (!p) throw new Error(`No ${name} binary is available for this platform.`);
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

export const ffmpegBin = (): string => unpacked(ffmpegPath, 'ffmpeg');
export const ffprobeBin = (): string => unpacked(ffprobePath, 'ffprobe');

export interface FfmpegProgress {
  frame: number;
  seconds: number;
}

export interface RunOptions {
  onProgress?: (p: FfmpegProgress) => void;
  signal?: AbortSignal;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/** Runs ffmpeg to completion. Rejects with the end of its error output when it fails. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const child = spawn(
      ffmpegBin(),
      ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-16000);
    });

    let buffer = '';
    const current: FfmpegProgress = { frame: 0, seconds: 0 };
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === 'frame') current.frame = Number(value) || 0;
        else if (key === 'out_time_us' || key === 'out_time_ms') {
          const us = Number(value);
          if (Number.isFinite(us)) current.seconds = Math.max(0, us / 1e6);
        } else if (key === 'progress') opts.onProgress?.({ ...current });
      }
    });

    const onAbort = (): void => {
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) reject(new CancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (code ${code}).\n${tail(stderr)}`));
    });
  });
}

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(tail(stderr) || `exited with code ${code}`));
    });
  });
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  channels?: number;
  color_space?: string;
  color_transfer?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
}

export interface ProbeData {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

export async function runFfprobe(file: string): Promise<ProbeData> {
  const text = await capture(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(text) as ProbeData;
}

let capsPromise: Promise<FfmpegCaps> | null = null;

/** What this ffmpeg build can do. Builds differ per platform, so features are checked rather than assumed. */
export function ffmpegCaps(): Promise<FfmpegCaps> {
  capsPromise ??= capture(ffmpegBin(), ['-hide_banner', '-filters'])
    .then((text) => ({ tonemap: /\bzscale\b/.test(text) && /\btonemap\b/.test(text) }))
    .catch(() => ({ tonemap: false }));
  return capsPromise;
}

let encodersPromise: Promise<string> | null = null;

export async function hasEncoder(name: string): Promise<boolean> {
  encodersPromise ??= capture(ffmpegBin(), ['-hide_banner', '-encoders']).catch(() => '');
  return new RegExp(`\\s${name}\\s`).test(await encodersPromise);
}
