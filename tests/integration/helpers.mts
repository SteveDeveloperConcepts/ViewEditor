// Shared helpers for tests that run the real ffmpeg binaries (no Electron involved).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset, ID, ProjectDoc } from '../../src/shared/types.ts';
import type { OutputSpec, RenderSource, TimeWindow } from '../../src/shared/render.ts';
import { buildRenderCommands, isSeekableExt, listOverlayFiles, planLayers, BLANK_OVERLAY } from '../../src/shared/render.ts';
import { extOf } from '../../src/shared/constants.ts';
import { newId } from '../../src/shared/time.ts';
import { probeMedia } from '../../src/main/probe.ts';
import { ffmpegCaps, runFfmpeg, runFfprobe } from '../../src/main/ffmpeg.ts';
import { runRenderCommands } from '../../src/main/renderRun.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const MEDIA = join(here, '..', 'fixtures', 'media');
export const media = (name: string): string => join(MEDIA, name);

export function workDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `vieweditor-${label}-`));
}

const assetPaths = new Map<ID, string>();

/** Probes a fixture the same way the importer does and wraps it as a library asset. */
export async function assetFor(name: string): Promise<Asset> {
  const file = media(name);
  const ext = extOf(name);
  const info = await probeMedia(file, ext);
  const id = newId('ast');
  assetPaths.set(id, file);
  return {
    id, kind: info.kind, name: basename(name), ext, size: 0, createdAt: 0, source: 'upload', scope: 'project', projectId: null,
    duration: info.duration, width: info.width, height: info.height, fps: info.fps,
    hasAudio: info.hasAudio, audioChannels: info.audioChannels, hasAlpha: info.hasAlpha, isHdr: info.isHdr,
    videoCodec: info.videoCodec, audioCodec: info.audioCodec, colorMatrix: info.colorMatrix,
    hasThumb: false, strip: null, hasWave: false, proxy: 'none', proxyExt: null, previewChecked: true, raster: 'none',
  };
}

export function sourcesFor(assets: Asset[]): Record<ID, RenderSource> {
  const out: Record<ID, RenderSource> = {};
  for (const a of assets) {
    out[a.id] = {
      path: assetPaths.get(a.id)!, kind: a.kind, hasAudio: a.hasAudio, audioChannels: a.audioChannels, hasAlpha: a.hasAlpha, isHdr: a.isHdr,
      colorMatrix: a.colorMatrix, videoCodec: a.videoCodec, seekable: isSeekableExt(a.ext),
    };
  }
  return out;
}

/** Stand-in for the renderer's text drawing: a white box per overlay segment, plus the blank frame. */
async function fakeOverlays(doc: ProjectDoc, window: TimeWindow, spec: OutputSpec, dir: string): Promise<void> {
  const size = `${spec.width}x${spec.height}`;
  await runFfmpeg(['-f', 'lavfi', '-i', `color=c=black@0.0:s=${size},format=rgba`, '-frames:v', '1', join(dir, BLANK_OVERLAY)]);
  const scale = spec.width / doc.settings.width;
  for (const f of listOverlayFiles(planLayers(doc, window))) {
    const boxes = f.itemIds
      .map((id) => doc.items.find((it) => it.id === id))
      .filter((it) => it?.type === 'text')
      .map((it) => {
        const t = it as { x: number; y: number; w: number; h: number };
        const [x0, y0, x1, y1] = [t.x, t.y, t.x + t.w, t.y + t.h].map((v) => Math.round(v * scale));
        return `between(X,${x0},${x1})*between(Y,${y0},${y1})`;
      });
    const alpha = boxes.length ? `if(${boxes.join('+')},255,0)` : '0';
    await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${size},format=rgba,geq=r=255:g=255:b=255:a='${alpha}'`,
      '-frames:v', '1', join(dir, f.file),
    ]);
  }
}

export interface Rendered {
  file: string;
  dir: string;
  totalFrames: number;
  chunkCount: number;
  progress: number[];
}

export async function render(
  doc: ProjectDoc,
  assets: Asset[],
  spec: OutputSpec,
  opts: { window?: TimeWindow; maxInputs?: number; label?: string } = {},
): Promise<Rendered> {
  const dir = workDir(opts.label ?? 'render');
  const window = opts.window ?? { start: 0, end: Math.max(0, ...doc.items.map((it) => it.start + it.duration)) };
  await fakeOverlays(doc, window, spec, dir);
  const file = join(dir, 'out.mp4');
  const cmds = buildRenderCommands({
    doc, window, spec, sources: sourcesFor(assets), workDir: dir, outputPath: file,
    caps: await ffmpegCaps(), maxInputs: opts.maxInputs,
  });
  const progress: number[] = [];
  await runRenderCommands(cmds, { onProgress: (p) => progress.push(p) });
  return { file, dir, totalFrames: cmds.totalFrames, chunkCount: cmds.chunks.length, progress };
}

export interface Described {
  duration: number;
  video: { codec: string; width: number; height: number; fps: number; pixFmt: string; frames: number; colorSpace?: string; colorTransfer?: string; colorRange?: string };
  audio: { codec: string; sampleRate: number; channels: number } | null;
}

export async function describe(file: string): Promise<Described> {
  const data = (await runFfprobe(file)) as unknown as {
    format: { duration: string };
    streams: Record<string, string | number>[];
  };
  const v = data.streams.find((s) => s.codec_type === 'video')!;
  const a = data.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
  return {
    duration: Number(data.format.duration),
    video: {
      codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: d ? n / d : n,
      pixFmt: String(v.pix_fmt), frames: Number(v.nb_frames),
      colorSpace: v.color_space as string, colorTransfer: v.color_transfer as string, colorRange: v.color_range as string,
    },
    audio: a ? { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels) } : null,
  };
}

/** Decodes one frame to RGB and returns a pixel reader. */
export async function frameAt(file: string, t: number, width: number, height: number): Promise<(x: number, y: number) => [number, number, number]> {
  const raw = join(dirname(file), `frame_${Math.round(t * 1000)}_${newId()}.rgb`);
  await runFfmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = readFileSync(raw);
  if (buf.length !== width * height * 3) throw new Error(`unexpected frame size ${buf.length} for ${width}x${height}`);
  return (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
}

export function near(actual: [number, number, number], expected: [number, number, number], tolerance = 12): boolean {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
}

/** Mean absolute level of the audio between two times, 0..1. */
export async function audioLevel(file: string, from: number, to: number): Promise<number> {
  const raw = join(dirname(file), `audio_${newId()}.raw`);
  await runFfmpeg(['-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', raw]);
  const buf = readFileSync(raw);
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) sum += Math.abs(buf.readInt16LE(i * 2));
  return n ? sum / n / 32768 : 0;
}
