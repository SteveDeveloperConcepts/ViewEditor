import type { EncodeSpeed, ExportAdvanced, RateControl, TextStyle } from './types.ts';

export const APP_NAME = 'ViewEditor';

// ---------------------------------------------------------------- supported files

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'ogv', 'flv', 'ts', 'gif'];
export const AUDIO_EXTS = ['mp3', 'm4a', 'ogg', 'oga', 'wav', 'aac', 'flac'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
export const ALL_MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];
export const FONT_EXTS = ['ttf', 'otf', 'woff', 'woff2'];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** A file name without its extension, as a title for what is in it. */
export function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

// ---------------------------------------------------------------- limits

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SCRIPT_MAX_CHARS = 5000;
export const MAX_EXPORT_FPS = 60;
export const MIN_ITEM_DURATION = 0.1;

// ---------------------------------------------------------------- canvas sizes

export interface SizePreset {
  id: string;
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: '16:9', label: 'Landscape 16:9', hint: 'YouTube, presentations', width: 1920, height: 1080 },
  { id: '9:16', label: 'Portrait 9:16', hint: 'TikTok, Reels, Shorts', width: 1080, height: 1920 },
  { id: '1:1', label: 'Square 1:1', hint: 'Instagram feed', width: 1080, height: 1080 },
  { id: '4:5', label: 'Portrait 4:5', hint: 'Instagram, Facebook feed', width: 1080, height: 1350 },
  { id: '4:3', label: 'Classic 4:3', hint: 'Slides, older footage', width: 1440, height: 1080 },
  { id: '21:9', label: 'Cinematic 21:9', hint: 'Ultrawide', width: 2520, height: 1080 },
];

export const DEFAULT_CANVAS = { width: 1920, height: 1080 };
export const FPS_OPTIONS = [24, 25, 30, 50, 60];

export function aspectLabel(w: number, h: number): string {
  const r = w / h;
  for (const p of SIZE_PRESETS) {
    if (Math.abs(p.width / p.height - r) < 0.01) return p.id;
  }
  return `${(r >= 1 ? r : 1 / r).toFixed(2)}:1${r >= 1 ? '' : ' portrait'}`;
}

// ---------------------------------------------------------------- export presets

export interface ExportPreset {
  id: string;
  label: string;
  group: 'Quality' | 'YouTube';
  description: string;
  resolution: number;
  rateControl: RateControl;
  crf: number;
  /** Constant-bitrate target at up to 30 fps. */
  bitrateKbps: number;
  /** Constant-bitrate target above 30 fps. */
  bitrateKbpsHfr: number;
  speed: EncodeSpeed;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'draft', label: 'Draft', group: 'Quality', resolution: 480,
    description: '480p · smallest file, quick to render',
    rateControl: 'vbr', crf: 28, bitrateKbps: 0, bitrateKbpsHfr: 0, speed: 'fast',
  },
  {
    id: 'standard', label: 'Standard', group: 'Quality', resolution: 720,
    description: '720p · good for sharing and messaging',
    rateControl: 'vbr', crf: 23, bitrateKbps: 0, bitrateKbpsHfr: 0, speed: 'balanced',
  },
  {
    id: 'hd', label: 'HD', group: 'Quality', resolution: 1080,
    description: '1080p · recommended for most videos',
    rateControl: 'vbr', crf: 20, bitrateKbps: 0, bitrateKbpsHfr: 0, speed: 'balanced',
  },
  {
    id: '4k', label: '4K', group: 'Quality', resolution: 2160,
    description: '2160p · best when your footage is 4K',
    rateControl: 'vbr', crf: 18, bitrateKbps: 0, bitrateKbpsHfr: 0, speed: 'balanced',
  },
  {
    id: 'yt-720', label: 'YouTube 720p', group: 'YouTube', resolution: 720,
    description: 'Constant bitrate · 5 Mbit/s (7.5 above 30 fps)',
    rateControl: 'cbr', crf: 20, bitrateKbps: 5000, bitrateKbpsHfr: 7500, speed: 'balanced',
  },
  {
    id: 'yt-1080', label: 'YouTube 1080p', group: 'YouTube', resolution: 1080,
    description: 'Constant bitrate · 8 Mbit/s (12 above 30 fps)',
    rateControl: 'cbr', crf: 20, bitrateKbps: 8000, bitrateKbpsHfr: 12000, speed: 'balanced',
  },
  {
    id: 'yt-1440', label: 'YouTube 1440p', group: 'YouTube', resolution: 1440,
    description: 'Constant bitrate · 16 Mbit/s (24 above 30 fps)',
    rateControl: 'cbr', crf: 20, bitrateKbps: 16000, bitrateKbpsHfr: 24000, speed: 'balanced',
  },
  {
    id: 'yt-2160', label: 'YouTube 4K', group: 'YouTube', resolution: 2160,
    description: 'Constant bitrate · 40 Mbit/s (60 above 30 fps)',
    rateControl: 'cbr', crf: 18, bitrateKbps: 40000, bitrateKbpsHfr: 60000, speed: 'balanced',
  },
];

export const DEFAULT_EXPORT_PRESET = 'hd';
export const RESOLUTION_OPTIONS = [480, 720, 1080, 1440, 2160];

export function getPreset(id: string): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS.find((p) => p.id === DEFAULT_EXPORT_PRESET)!;
}

export function advancedFromPreset(id: string, fps: number): ExportAdvanced {
  const p = getPreset(id);
  return {
    resolution: p.resolution,
    rateControl: p.rateControl,
    crf: p.crf,
    bitrateKbps: (fps > 30 ? p.bitrateKbpsHfr : p.bitrateKbps) || defaultBitrate(p.resolution, fps),
    speed: p.speed,
  };
}

/** A sensible constant-bitrate target when the user switches a VBR preset to CBR. */
export function defaultBitrate(resolution: number, fps: number): number {
  const base = resolution >= 2160 ? 40000 : resolution >= 1440 ? 16000 : resolution >= 1080 ? 8000 : resolution >= 720 ? 5000 : 2500;
  return fps > 30 ? Math.round(base * 1.5) : base;
}

export function resolutionLabel(res: number): string {
  return res >= 2160 ? '4K' : `${res}p`;
}

// ---------------------------------------------------------------- text

export const FONT_FAMILIES = [
  'Arial',
  'Georgia',
  'Impact',
  'Verdana',
  'Trebuchet MS',
  'Times New Roman',
  'Courier New',
  'Tahoma',
];

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Arial',
  fontSize: 96,
  bold: true,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  bgColor: null,
  bgPadding: 18,
  bgRadius: 12,
  strokeColor: null,
  strokeWidth: 6,
  shadow: true,
};

export interface SubtitleStylePreset {
  id: string;
  label: string;
  style: Partial<TextStyle>;
}

/** Subtitle looks. Font sizes are relative to a 1080-pixel short side and scaled per project. */
export const SUBTITLE_STYLES: SubtitleStylePreset[] = [
  {
    id: 'clean', label: 'Clean',
    style: { fontFamily: 'Arial', fontSize: 54, bold: true, color: '#ffffff', bgColor: null, strokeColor: '#000000', strokeWidth: 8, shadow: false },
  },
  {
    id: 'boxed', label: 'Boxed',
    style: { fontFamily: 'Arial', fontSize: 50, bold: true, color: '#ffffff', bgColor: '#000000', bgPadding: 16, bgRadius: 10, strokeColor: null, shadow: false },
  },
  {
    id: 'pop', label: 'Pop',
    style: { fontFamily: 'Impact', fontSize: 66, bold: false, uppercase: true, color: '#ffe14d', bgColor: null, strokeColor: '#000000', strokeWidth: 10, shadow: true },
  },
  {
    id: 'soft', label: 'Soft',
    style: { fontFamily: 'Georgia', fontSize: 52, bold: false, italic: true, color: '#ffffff', bgColor: null, strokeColor: null, shadow: true },
  },
  {
    id: 'paper', label: 'Paper',
    style: { fontFamily: 'Verdana', fontSize: 46, bold: true, color: '#111111', bgColor: '#ffffff', bgPadding: 16, bgRadius: 10, strokeColor: null, shadow: false },
  },
];

export const BACKGROUND_SWATCHES = ['#000000', '#ffffff', '#101828', '#1d2b53', '#0f766e', '#7c2d12', '#581c87', '#be123c', '#f59e0b', '#e2e8f0'];
