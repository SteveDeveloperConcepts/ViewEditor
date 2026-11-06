import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RenderCommands } from '../shared/render.ts';
import { runFfmpeg } from './ffmpeg.ts';

export interface RenderRunOptions {
  /** 0..1 over the whole job. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Stops after the sound, for exports that have no picture. */
  soundOnly?: boolean;
}

// Share of the progress bar given to each stage. Video encoding dominates.
const AUDIO_SHARE = 0.06;
const MUX_SHARE = 0.04;
const VIDEO_SHARE = 1 - AUDIO_SHARE - MUX_SHARE;

/** Executes a render plan: audio mix, then each video chunk, then the final mux. */
export async function runRenderCommands(cmds: RenderCommands, opts: RenderRunOptions = {}): Promise<void> {
  const report = (f: number): void => opts.onProgress?.(Math.max(0, Math.min(1, f)));

  for (const f of cmds.textFiles) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content, 'utf8');
  }

  report(0);
  const share = opts.soundOnly ? 1 : AUDIO_SHARE;
  await runFfmpeg(cmds.audio.args, {
    signal: opts.signal,
    onProgress: (p) => report(share * Math.min(1, p.seconds / Math.max(0.001, cmds.duration))),
  });
  if (opts.soundOnly) return;

  let framesDone = 0;
  for (const chunk of cmds.chunks) {
    const base = framesDone;
    await runFfmpeg(chunk.args, {
      signal: opts.signal,
      onProgress: (p) => report(AUDIO_SHARE + (VIDEO_SHARE * (base + Math.min(chunk.frames, p.frame))) / cmds.totalFrames),
    });
    framesDone += chunk.frames;
  }

  report(AUDIO_SHARE + VIDEO_SHARE);
  await runFfmpeg(cmds.mux.args, { signal: opts.signal });
  report(1);
}
