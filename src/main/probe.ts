import { IMAGE_EXTS, AUDIO_EXTS } from '../shared/constants.ts';
import type { AssetKind, ColorMatrix } from '../shared/types.ts';
import { runFfprobe, type ProbeStream } from './ffmpeg.ts';

export interface ProbeInfo {
  kind: AssetKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  audioChannels: number;
  hasAlpha: boolean;
  isHdr: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  pixFmt: string | null;
  colorMatrix: ColorMatrix;
}

function rate(text: string | undefined): number {
  if (!text) return 0;
  const [a, b] = text.split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function rotationOf(v: ProbeStream): number {
  for (const sd of v.side_data_list ?? []) {
    if (sd.rotation !== undefined) return Number(sd.rotation) || 0;
  }
  return Number(v.tags?.rotate) || 0;
}

const RGB_FORMAT = /^(rgb|bgr|gbr|argb|abgr|rgba|bgra|pal8|gray|ya\d|mono)/;
const ALPHA_FORMAT = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|pal8)/;

function matrixOf(v: ProbeStream, kind: AssetKind, width: number, height: number): ColorMatrix {
  if (RGB_FORMAT.test(v.pix_fmt ?? '')) return 'rgb';
  switch (v.color_space) {
    case 'bt709':
      return 'bt709';
    case 'smpte170m':
    case 'bt470bg':
      return 'bt601';
    case 'bt2020nc':
    case 'bt2020c':
      return 'bt2020';
  }
  // Untagged: JPEG is BT.601 by definition; video follows the usual size rule (HD is BT.709).
  if (kind === 'image') return 'bt601';
  return width >= 1280 || height > 576 ? 'bt709' : 'bt601';
}

/** Reads what the importer needs to know about a media file. Throws when the file has no usable stream. */
export async function probeMedia(file: string, ext: string): Promise<ProbeInfo> {
  const data = await runFfprobe(file);
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');

  let duration = Number(data.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;

  let kind: AssetKind;
  if (AUDIO_EXTS.includes(ext) && a) kind = 'audio';
  else if (v && IMAGE_EXTS.includes(ext)) kind = 'image';
  else if (v) kind = ext === 'gif' && duration < 0.15 ? 'image' : 'video';
  else if (a) kind = 'audio';
  else throw new Error('No video, audio or image data found in this file.');

  if (kind === 'audio') {
    if (duration <= 0) throw new Error('This audio file has no duration.');
    return {
      kind, duration, width: 0, height: 0, fps: 0, hasAudio: true, audioChannels: a?.channels ?? 0, hasAlpha: false, isHdr: false,
      videoCodec: null, audioCodec: a?.codec_name ?? null, pixFmt: null, colorMatrix: 'bt709',
    };
  }

  const vs = v!;
  let width = vs.width ?? 0;
  let height = vs.height ?? 0;
  if (width <= 0 || height <= 0) throw new Error('Could not read the picture size of this file.');
  const sar = (vs.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  if (sar.length === 2 && sar[0] > 0 && sar[1] > 0 && sar[0] !== sar[1]) width = Math.round((width * sar[0]) / sar[1]);
  if (Math.abs(rotationOf(vs)) % 180 === 90) [width, height] = [height, width];

  const pixFmt = vs.pix_fmt ?? null;
  const tags = Object.fromEntries(Object.entries(vs.tags ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  const hasAlpha = ALPHA_FORMAT.test(pixFmt ?? '') || tags.alpha_mode === '1';

  if (kind === 'image') {
    return {
      kind, duration: 0, width, height, fps: 0, hasAudio: false, audioChannels: 0, hasAlpha, isHdr: false,
      videoCodec: vs.codec_name ?? null, audioCodec: null, pixFmt, colorMatrix: matrixOf(vs, kind, width, height),
    };
  }

  let fps = rate(vs.avg_frame_rate);
  if (fps <= 0 || fps > 240) fps = rate(vs.r_frame_rate);
  if (fps <= 0 || fps > 240) fps = 30;
  if (duration <= 0) {
    const frames = Number(vs.nb_frames) || 0;
    duration = frames > 0 ? frames / fps : 0;
  }
  if (duration <= 0) throw new Error('This video has no duration.');

  return {
    kind, duration, width, height, fps: Math.round(fps * 1000) / 1000,
    hasAudio: !!a, audioChannels: a?.channels ?? 0, hasAlpha,
    isHdr: vs.color_transfer === 'smpte2084' || vs.color_transfer === 'arib-std-b67',
    videoCodec: vs.codec_name ?? null, audioCodec: a?.codec_name ?? null, pixFmt,
    colorMatrix: matrixOf(vs, kind, width, height),
  };
}
