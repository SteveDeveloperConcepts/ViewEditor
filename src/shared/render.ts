// Turns a project into ffmpeg command lines. Pure: no file system, no process spawning.
//
// The export is built from three kinds of ffmpeg runs:
//   1. one audio pass that mixes every audible clip into a lossless intermediate,
//   2. one or more video "chunks" (the timeline cut at clip boundaries so that no single
//      run has to keep more than a handful of decoders open),
//   3. a final mux that joins the chunks without re-encoding and adds AAC audio.
//
// Text is drawn by the renderer process (the same canvas code as the preview) into
// full-frame transparent PNGs, one per stretch of time in which the visible text is constant.
// Those PNGs reach ffmpeg as a single concat input per run of text layers.

import type { Asset, ColorMatrix, ExportAdvanced, ID, ImageItem, Item, ProjectDoc, TextItem, VideoItem } from './types.ts';
import { MAX_EXPORT_FPS, advancedFromPreset, getPreset, resolutionLabel } from './constants.ts';
import { EPS, isTimed, itemEnd, projectDuration } from './timeline.ts';

// ---------------------------------------------------------------- output spec

export interface OutputSpec {
  width: number;
  height: number;
  fps: number;
  rateControl: 'vbr' | 'cbr';
  crf: number;
  bitrateKbps: number;
  x264Preset: 'veryfast' | 'medium' | 'slow';
  audioKbps: number;
  label: string;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Frame size for a canvas exported at a given short-side resolution (1080 → 1920×1080 for 16:9). */
export function exportSize(canvasW: number, canvasH: number, shortSide: number): { width: number; height: number } {
  const s = shortSide / Math.min(canvasW, canvasH);
  return { width: even(canvasW * s), height: even(canvasH * s) };
}

/** The export settings in force: the "Advanced" overrides when present, otherwise the chosen preset. */
export function effectiveAdvanced(doc: ProjectDoc): ExportAdvanced {
  return doc.settings.exportAdvanced ?? advancedFromPreset(doc.settings.exportPresetId, doc.settings.fps);
}

/**
 * Frame rate of the export. The project setting is a ceiling: when the footage runs slower
 * than that, the footage's own rate is used, and nothing goes above 60 fps.
 */
export function effectiveFps(doc: ProjectDoc, assets: Record<ID, Asset | undefined>): number {
  let fps = doc.settings.fps;
  let fastestSource = 0;
  for (const it of doc.items) {
    if (it.type !== 'video') continue;
    const a = assets[it.assetId];
    if (a && a.fps > 0) fastestSource = Math.max(fastestSource, a.fps);
  }
  if (fastestSource > 0 && fastestSource < fps) fps = fastestSource;
  fps = Math.min(fps, MAX_EXPORT_FPS);
  return Math.max(1, Math.round(fps * 1000) / 1000);
}

/** Largest short side among the visual media in the project (0 when there is none). */
export function sourceResolution(doc: ProjectDoc, assets: Record<ID, Asset | undefined>): number {
  let best = 0;
  for (const it of doc.items) {
    if (it.type !== 'video' && it.type !== 'image') continue;
    const a = assets[it.assetId];
    if (a) best = Math.max(best, Math.min(a.width, a.height));
  }
  return best;
}

export function resolveOutputSpec(doc: ProjectDoc, assets: Record<ID, Asset | undefined>): OutputSpec {
  const adv = effectiveAdvanced(doc);
  const fps = effectiveFps(doc, assets);
  const { width, height } = exportSize(doc.settings.width, doc.settings.height, adv.resolution);
  const preset = getPreset(doc.settings.exportPresetId);
  return {
    width,
    height,
    fps,
    rateControl: adv.rateControl,
    crf: adv.crf,
    bitrateKbps: adv.bitrateKbps,
    x264Preset: adv.speed === 'fast' ? 'veryfast' : adv.speed === 'compact' ? 'slow' : 'medium',
    audioKbps: 320,
    label: doc.settings.exportAdvanced ? `Custom ${resolutionLabel(adv.resolution)}` : preset.label,
  };
}

// ---------------------------------------------------------------- windows

export interface TimeWindow {
  start: number;
  end: number;
}

/** The part of an item inside a time window, re-based so the window starts at 0. */
export function windowItem<T extends Item>(it: T, w: TimeWindow): T | null {
  const s = Math.max(it.start, w.start);
  const e = Math.min(itemEnd(it), w.end);
  if (e - s <= EPS) return null;
  const out = { ...it, start: s - w.start, duration: e - s };
  if (isTimed(it)) (out as unknown as { trimStart: number }).trimStart = it.trimStart + (s - it.start) * it.speed;
  return out;
}

export function fullWindow(doc: ProjectDoc): TimeWindow {
  return { start: 0, end: projectDuration(doc) };
}

// ---------------------------------------------------------------- layers

export interface OverlaySegment {
  start: number;
  end: number;
  /** Text items visible for the whole segment, bottom layer first. Empty means nothing to draw. */
  itemIds: ID[];
}

export interface OverlayRun {
  index: number;
  segments: OverlaySegment[];
}

export type LayerOp = { kind: 'media'; item: VideoItem | ImageItem } | { kind: 'overlay'; run: number };

export interface LayerPlan {
  duration: number;
  /** Compositing order, bottom layer first. */
  ops: LayerOp[];
  runs: OverlayRun[];
  /** Every item intersecting the window, re-based to the window. */
  items: Item[];
}

function segmentsFor(texts: TextItem[], duration: number): OverlaySegment[] {
  const cuts = new Set<number>([0, duration]);
  for (const t of texts) {
    cuts.add(Math.max(0, t.start));
    cuts.add(Math.min(duration, itemEnd(t)));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: OverlaySegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a <= EPS) continue;
    const itemIds = texts.filter((t) => t.start <= a + EPS && itemEnd(t) >= b - EPS).map((t) => t.id);
    const prev = out[out.length - 1];
    if (prev && prev.itemIds.length === itemIds.length && prev.itemIds.every((id, k) => id === itemIds[k])) prev.end = b;
    else out.push({ start: a, end: b, itemIds });
  }
  return out;
}

/** Works out what gets composited, in which order, for a window of the timeline. */
export function planLayers(doc: ProjectDoc, window: TimeWindow): LayerPlan {
  const duration = Math.max(0, window.end - window.start);
  const items = doc.items.map((it) => windowItem(it, window)).filter((it): it is Item => it !== null);
  const ops: LayerOp[] = [];
  const runTexts: TextItem[][] = [];
  let open: TextItem[] | null = null;
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    const onTrack = items.filter((it) => it.trackId === doc.tracks[i].id).sort((a, b) => a.start - b.start);
    const media = onTrack.filter((it): it is VideoItem | ImageItem => it.type === 'video' || it.type === 'image');
    const texts = onTrack.filter((it): it is TextItem => it.type === 'text' && it.text.trim().length > 0);
    if (media.length) {
      open = null;
      for (const m of media) ops.push({ kind: 'media', item: m });
    }
    if (texts.length) {
      if (!open) {
        open = [];
        runTexts.push(open);
        ops.push({ kind: 'overlay', run: runTexts.length - 1 });
      }
      open.push(...texts);
    }
  }
  const runs = runTexts.map((texts, index) => ({ index, segments: segmentsFor(texts, duration) }));
  return { duration, ops, runs, items };
}

export const BLANK_OVERLAY = 'blank.png';

export function overlayFileName(run: number, segment: number): string {
  return `ov_${run}_${segment}.png`;
}

/** The PNGs the renderer process has to draw before the export can start. */
export function listOverlayFiles(plan: LayerPlan): { file: string; itemIds: ID[] }[] {
  const out: { file: string; itemIds: ID[] }[] = [];
  for (const run of plan.runs) {
    run.segments.forEach((seg, i) => {
      if (seg.itemIds.length) out.push({ file: overlayFileName(run.index, i), itemIds: seg.itemIds });
    });
  }
  return out;
}

// ---------------------------------------------------------------- chunks

export interface ChunkPlan {
  startFrame: number;
  endFrame: number;
}

/**
 * Cuts the timeline into consecutive pieces at clip boundaries so that each piece touches at most
 * `maxInputs` media clips. A project with a hundred cuts then never opens a hundred decoders at once.
 */
export function planChunks(plan: LayerPlan, fps: number, maxInputs = 10): ChunkPlan[] {
  const total = Math.max(1, Math.round(plan.duration * fps));
  const media = plan.ops.flatMap((op) => (op.kind === 'media' ? [op.item] : []));
  const bounds = new Set<number>([total]);
  for (const m of media) {
    for (const t of [m.start, itemEnd(m)]) {
      const f = Math.round(t * fps);
      if (f > 0 && f < total) bounds.add(f);
    }
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const countIn = (f0: number, f1: number): number =>
    media.filter((m) => m.start * fps < f1 - 0.5 && itemEnd(m) * fps > f0 + 0.5).length;
  const chunks: ChunkPlan[] = [];
  let c0 = 0;
  let lastOk: number | null = null;
  for (const b of sorted) {
    if (lastOk !== null && countIn(c0, b) > maxInputs) {
      chunks.push({ startFrame: c0, endFrame: lastOk });
      c0 = lastOk;
    }
    lastOk = b;
  }
  chunks.push({ startFrame: c0, endFrame: total });
  return chunks;
}

// ---------------------------------------------------------------- commands

export interface RenderSource {
  /** File ffmpeg reads: the original media, or the PNG raster for images that needed one. */
  path: string;
  kind: 'video' | 'audio' | 'image';
  hasAudio: boolean;
  /** Channel count of the first audio stream (0 when unknown). */
  audioChannels: number;
  hasAlpha: boolean;
  isHdr: boolean;
  colorMatrix: ColorMatrix;
  videoCodec: string | null;
  /**
   * False for containers that cannot be seeked to an exact time (MPEG-TS, GIF, raw AAC).
   * Those are decoded from the start and trimmed, which is slower but always lands on the right frame.
   */
  seekable: boolean;
}

export function isSeekableExt(ext: string): boolean {
  return ext !== 'ts' && ext !== 'gif' && ext !== 'aac';
}

export interface FfmpegCaps {
  /** zscale + tonemap are available, so HDR sources can be converted to SDR properly. */
  tonemap: boolean;
}

export interface BuildInput {
  doc: ProjectDoc;
  window: TimeWindow;
  spec: OutputSpec;
  sources: Record<ID, RenderSource | undefined>;
  /** Directory for intermediates; overlay PNGs are expected in here too. */
  workDir: string;
  outputPath: string;
  caps: FfmpegCaps;
  maxInputs?: number;
}

export interface RenderCommands {
  /** Text files (concat lists) that must exist before running anything. */
  textFiles: { path: string; content: string }[];
  audio: { args: string[]; out: string };
  chunks: { args: string[]; frames: number; out: string }[];
  mux: { args: string[] };
  totalFrames: number;
  duration: number;
}

/** Filter chain that tone-maps HDR (PQ or HLG) video down to SDR BT.709. */
export const HDR_TO_SDR =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** Compact decimal for ffmpeg arguments. */
export function num(v: number): string {
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

/** NTSC rates are passed as exact fractions; everything else as a decimal. */
export function fpsArg(fps: number): string {
  for (const base of [24, 30, 60]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.01) return `${base * 1000}/1001`;
  }
  return num(fps);
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`;
}

function concatList(entries: { file: string; duration: number; options?: string[] }[]): string {
  const lines = ['ffconcat version 1.0'];
  for (const e of entries) {
    lines.push(`file '${e.file.replace(/'/g, "'\\''")}'`);
    for (const o of e.options ?? []) lines.push(`option ${o}`);
    lines.push(`duration ${num(e.duration)}`);
  }
  return lines.join('\n') + '\n';
}

function rateArgs(spec: OutputSpec): string[] {
  if (spec.rateControl === 'cbr') {
    const k = Math.max(100, Math.round(spec.bitrateKbps));
    return ['-b:v', `${k}k`, '-minrate', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`];
  }
  return ['-crf', String(Math.round(spec.crf))];
}

function buildChunk(
  input: BuildInput,
  plan: LayerPlan,
  chunk: ChunkPlan,
  index: number,
  textFiles: { path: string; content: string }[],
): { args: string[]; frames: number; out: string } {
  const { spec, doc, sources, workDir, caps } = input;
  const fps = spec.fps;
  const frames = chunk.endFrame - chunk.startFrame;
  const win: TimeWindow = { start: chunk.startFrame / fps, end: chunk.endFrame / fps };
  const half = 0.5 / fps;
  const scale = spec.width / doc.settings.width;
  const bg = /^#[0-9a-f]{6}$/i.test(doc.settings.background) ? doc.settings.background.slice(1) : '000000';

  const inputs: string[] = ['-f', 'lavfi', '-i', `color=c=0x${bg}:s=${spec.width}x${spec.height}:r=${fpsArg(fps)}:d=${num((frames + 1) / fps)}`];
  const graph: string[] = ['[0:v]format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1[b0]'];
  let last = 'b0';
  let n = 1;

  for (const op of plan.ops) {
    if (op.kind === 'media') {
      const it = windowItem(op.item, win);
      const src = it ? sources[it.assetId] : undefined;
      if (!it || !src || it.duration < half) continue;
      const w = even(it.w * scale);
      const h = even(it.h * scale);
      const x = Math.round(it.x * scale);
      const y = Math.round(it.y * scale);
      const alpha = src.hasAlpha || it.opacity < 0.999;
      const filters: string[] = [];
      if (it.type === 'video') {
        if (src.hasAlpha && (src.videoCodec === 'vp9' || src.videoCodec === 'vp8')) {
          inputs.push('-c:v', src.videoCodec === 'vp9' ? 'libvpx-vp9' : 'libvpx');
        }
        const span = it.duration * it.speed + 2 / fps;
        if (src.seekable) inputs.push('-ss', num(it.trimStart), '-t', num(span), '-i', src.path);
        else {
          inputs.push('-i', src.path);
          filters.push(`trim=start=${num(it.trimStart)}:duration=${num(span)}`);
        }
      } else {
        inputs.push('-i', src.path);
      }
      let matrix = src.colorMatrix;
      if (it.type === 'video' && src.isHdr && caps.tonemap) {
        filters.push(HDR_TO_SDR);
        matrix = 'bt709';
      }
      filters.push(
        `scale=${w}:${h}:flags=bicubic${matrix === 'rgb' ? '' : `:in_color_matrix=${matrix}`}:out_color_matrix=bt709:out_range=tv`,
        `format=${alpha ? 'yuva420p' : 'yuv420p'}`,
      );
      if (it.opacity < 0.999) filters.push(`colorchannelmixer=aa=${num(Math.max(0, it.opacity))}`);
      filters.push('setsar=1');
      // Shifted half a frame early so rounding can never make the layer miss its first frame.
      const offset = num(it.start - half);
      filters.push(it.type === 'video' ? `setpts=(PTS-STARTPTS)/${num(it.speed)}+${offset}/TB` : `setpts=PTS-STARTPTS+${offset}/TB`);
      graph.push(`[${n}:v]${filters.join(',')}[v${n}]`);
      graph.push(
        `[${last}][v${n}]overlay=x=${x}:y=${y}:eval=init:eof_action=repeat:enable='gte(t,${num(it.start - half)})*lt(t,${num(itemEnd(it) - half)})'[o${n}]`,
      );
      last = `o${n}`;
      n++;
    } else {
      const run = plan.runs[op.run];
      const entries: { file: string; duration: number; options: string[] }[] = [];
      let any = false;
      let cursor = 0;
      run.segments.forEach((seg, i) => {
        const s = Math.max(seg.start, win.start);
        const e = Math.min(seg.end, win.end);
        if (e - s <= EPS) return;
        // Interior boundaries sit half a frame early, for the same reason as above.
        const localEnd = e >= win.end - EPS ? win.end - win.start : e - win.start - half;
        if (localEnd - cursor <= EPS) return;
        if (seg.itemIds.length) any = true;
        entries.push({
          file: seg.itemIds.length ? overlayFileName(run.index, i) : BLANK_OVERLAY,
          duration: localEnd - cursor,
          options: ['framerate 1000'],
        });
        cursor = localEnd;
      });
      if (!any) continue;
      const listName = `overlay_${index}_${run.index}.txt`;
      textFiles.push({ path: joinPath(workDir, listName), content: concatList(entries) });
      inputs.push('-f', 'concat', '-safe', '0', '-i', joinPath(workDir, listName));
      graph.push(`[${n}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,setsar=1[v${n}]`);
      graph.push(`[${last}][v${n}]overlay=x=0:y=0:eval=init:eof_action=repeat[o${n}]`);
      last = `o${n}`;
      n++;
    }
  }
  graph.push(`[${last}]setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709[vout]`);

  const out = joinPath(workDir, `chunk_${String(index).padStart(4, '0')}.mkv`);
  const args = [
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-an',
    '-c:v', 'libx264', '-preset', spec.x264Preset, ...rateArgs(spec),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-g', String(Math.max(1, Math.round(fps * 2))),
    '-r', fpsArg(fps), '-fps_mode', 'cfr', '-frames:v', String(frames),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-f', 'matroska', out,
  ];
  return { args, frames, out };
}

function tempoFilters(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5 - EPS) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 100) {
    out.push('atempo=100');
    s /= 100;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${num(s)}`);
  return out;
}

export const AUDIO_FADE_SECONDS = 0.5;

function buildAudio(input: BuildInput, plan: LayerPlan): { args: string[]; out: string } {
  const { sources, workDir } = input;
  const duration = plan.duration;
  const inputs: string[] = ['-f', 'lavfi', '-t', num(duration), '-i', 'anullsrc=r=48000:cl=stereo'];
  const graph: string[] = [];
  const labels: string[] = ['[0:a]'];
  let n = 1;
  for (const it of plan.items) {
    if (!isTimed(it) || it.muted || it.volume <= 0.001) continue;
    const src = sources[it.assetId];
    if (!src || !src.hasAudio) continue;
    const span = it.duration * it.speed;
    if (src.seekable) inputs.push('-ss', num(it.trimStart), '-t', num(span), '-vn', '-i', src.path);
    else inputs.push('-vn', '-i', src.path);
    // Mono goes to both speakers at full level, exactly as the preview plays it
    // (the default up-mix would drop it by 3 dB).
    const filters = [
      ...(src.seekable ? [] : [`atrim=start=${num(it.trimStart)}:duration=${num(span)}`, 'asetpts=PTS-STARTPTS']),
      'aresample=48000',
      ...(src.audioChannels === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []),
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ...tempoFilters(it.speed),
    ];
    if (Math.abs(it.volume - 1) > 1e-3) filters.push(`volume=${num(it.volume)}`);
    if (it.fadeAudio) {
      const f = Math.min(AUDIO_FADE_SECONDS, it.duration / 2);
      filters.push(`afade=t=in:st=0:d=${num(f)}`, `afade=t=out:st=${num(it.duration - f)}:d=${num(f)}`);
    }
    if (it.start > EPS) filters.push(`adelay=${Math.round(it.start * 1000)}:all=1`);
    graph.push(`[${n}:a]${filters.join(',')}[a${n}]`);
    labels.push(`[a${n}]`);
    n++;
  }
  graph.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.97:level=0:latency=1[aout]`,
  );
  const out = joinPath(workDir, 'audio.flac');
  const args = [...inputs, '-filter_complex', graph.join(';'), '-map', '[aout]', '-c:a', 'flac', '-sample_fmt', 's32', '-ar', '48000', '-ac', '2', out];
  return { args, out };
}

/** Everything needed to render a window of the project to an MP4. */
export function buildRenderCommands(input: BuildInput): RenderCommands {
  const { doc, window, spec, workDir } = input;
  const plan = planLayers(doc, window);
  const fps = spec.fps;
  const totalFrames = Math.max(1, Math.round(plan.duration * fps));
  const duration = totalFrames / fps;
  const framed: LayerPlan = { ...plan, duration };

  const textFiles: { path: string; content: string }[] = [];
  const chunks = planChunks(framed, fps, input.maxInputs).map((c, i) => buildChunk(input, framed, c, i, textFiles));

  const listPath = joinPath(workDir, 'chunks.txt');
  textFiles.push({
    path: listPath,
    content: concatList(chunks.map((c) => ({ file: c.out.slice(c.out.lastIndexOf('/') + 1), duration: c.frames / fps }))),
  });

  const audio = buildAudio(input, framed);
  const mux = {
    args: [
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-i', audio.out,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${spec.audioKbps}k`,
      '-t', num(duration),
      '-movflags', '+faststart',
      input.outputPath,
    ],
  };
  return { textFiles, audio, chunks, mux, totalFrames, duration };
}

// ---------------------------------------------------------------- downloads derived from an export

export function mp3Args(src: string, out: string): string[] {
  return ['-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', out];
}

/** GIFs carry at most 256 colours per frame, so the picture is kept small and the palette is tuned per clip. */
export function gifArgs(src: string, out: string, width: number): string[] {
  const w = Math.min(480, even(width));
  return [
    '-i', src,
    '-filter_complex', `[0:v]fps=12,scale=${w}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    '-loop', '0', out,
  ];
}
