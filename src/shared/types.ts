// Data model shared by the main process, the preload bridge and the renderer.
// Everything here is plain JSON so it can be persisted and sent over IPC as-is.

import type { AiJob } from './ai.ts';

export type ID = string;

// ---------------------------------------------------------------- assets

export type AssetKind = 'video' | 'audio' | 'image';
export type AssetSource = 'upload' | 'recording' | 'voiceover' | 'generated' | 'phone' | 'ai' | 'extracted' | 'stock';

/** Where AI-generated media came from. */
export interface AssetOrigin {
  provider: string;
  model: string;
  prompt: string;
}

/** Where a free clip came from, so the person who made it can be credited and its licence found again. */
export interface AssetCredit {
  /** Which clip this is, across services: 'pexels:1448735'. */
  key: string;
  service: string;
  creator: string;
  creatorUrl: string | null;
  pageUrl: string;
  licenseUrl: string;
}

/** Colour matrix of the source pixels, resolved at import so export never has to guess. */
export type ColorMatrix = 'bt709' | 'bt601' | 'bt2020' | 'rgb';

export interface Asset {
  id: ID;
  kind: AssetKind;
  name: string;
  /** Lower-case extension of the stored original, without the dot. */
  ext: string;
  size: number;
  createdAt: number;
  source: AssetSource;
  origin?: AssetOrigin | null;
  credit?: AssetCredit | null;
  /** The video this sound was taken from. */
  extractedFrom?: ID | null;
  /** Everything in Media is 'workspace'. 'project' is left over from when media belonged to one project. */
  scope: 'workspace' | 'project';
  projectId: ID | null;

  duration: number;
  /** Display size in pixels (rotation and pixel aspect already applied). 0 for audio. */
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** Channel count of the first audio stream (0 when there is none). */
  audioChannels: number;
  hasAlpha: boolean;
  isHdr: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  colorMatrix: ColorMatrix;

  /** Poster frame available (thumb.jpg / thumb.webp). */
  hasThumb: boolean;
  /** Filmstrip sprite for the timeline. */
  strip: { count: number; tileW: number; tileH: number } | null;
  /** Waveform picture for the timeline. */
  hasWave: boolean;
  /**
   * Preview proxy. The editor plays a proxy when Chromium cannot decode the original;
   * export always reads the original file.
   */
  proxy: 'none' | 'pending' | 'ready' | 'failed';
  proxyExt: 'mp4' | 'webm' | 'm4a' | null;
  /** True once the renderer has confirmed it can play/draw this asset (or its proxy). */
  previewChecked: boolean;
  /** Images only: a PNG copy decoded by Chromium, used when ffmpeg cannot be trusted to decode the original. */
  raster: 'none' | 'ready';
}

// ---------------------------------------------------------------- library

export interface Space {
  id: ID;
  name: string;
  createdAt: number;
  /** The first space cannot be deleted; projects from deleted spaces land here. */
  isDefault: boolean;
}

export interface Folder {
  id: ID;
  spaceId: ID;
  parentId: ID | null;
  name: string;
  createdAt: number;
}

export interface ExportInfo {
  id: ID;
  /** File name inside the project's export folder. */
  file: string;
  createdAt: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  size: number;
  presetLabel: string;
}

export interface ScriptOrigin {
  mode: 'topic' | 'script';
  topic: string;
  script: string;
  settings: ScriptVideoSettings;
}

export interface ProjectMeta {
  id: ID;
  spaceId: ID;
  folderId: ID | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  duration: number;
  width: number;
  height: number;
  /** Bumped whenever the thumbnail file is rewritten, to bust the image cache. */
  thumbVersion: number;
  assetIds: ID[];
  lastExport: ExportInfo | null;
  /** True when the project changed after its last export (the export is stale). */
  editedSinceExport: boolean;
  /** Present on projects made from a script, so "Reuse topic / Reuse script" can refill the form. */
  scriptOrigin: ScriptOrigin | null;
}

export interface TemplateMeta {
  id: ID;
  name: string;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  thumbVersion: number;
  assetIds: ID[];
}

export interface BrandFont {
  id: ID;
  family: string;
  /** File name inside the brand kit folder. */
  file: string;
}

export interface BrandKit {
  id: ID;
  name: string;
  createdAt: number;
  colors: string[];
  logoAssetIds: ID[];
  fonts: BrandFont[];
}

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface AppSettings {
  workspaceName: string;
  profileName: string;
  theme: ThemeSetting;
  /** Whether an Anthropic API key is stored (the key itself never leaves the main process). */
  hasApiKey: boolean;
  lastSpaceId: ID | null;
}

export interface Library {
  version: 1;
  spaces: Space[];
  folders: Folder[];
  projects: ProjectMeta[];
  templates: TemplateMeta[];
  assets: Asset[];
  brandKits: BrandKit[];
  settings: AppSettings;
  /** Media folders the user deleted that could not be removed yet (still in use); retried at the next start. */
  pendingAssetDeletes?: ID[];
  /** AI generation jobs, running and recently finished. */
  aiJobs?: AiJob[];
}

// ---------------------------------------------------------------- project document

export type RateControl = 'vbr' | 'cbr';
export type EncodeSpeed = 'fast' | 'balanced' | 'compact';

export interface ExportAdvanced {
  /** Short side of the exported frame in pixels (720, 1080, …). */
  resolution: number;
  rateControl: RateControl;
  /** x264 CRF for variable bitrate (lower is better quality). */
  crf: number;
  /** Target for constant bitrate, in kbit/s. */
  bitrateKbps: number;
  speed: EncodeSpeed;
}

export interface ProjectSettings {
  width: number;
  height: number;
  /** While true the canvas adopts the size of the first visual media added. */
  autoSize: boolean;
  fps: number;
  background: string;
  durationMode: 'auto' | 'fixed';
  fixedDuration: number;
  exportPresetId: string;
  /** Set when the user customised the export under "Advanced"; overrides the preset. */
  exportAdvanced: ExportAdvanced | null;
}

export interface Track {
  id: ID;
  /** A name of your own, instead of the one worked out from what is on the row. */
  name?: string;
  /** The row's picture is left out, though its sound still plays. */
  hidden?: boolean;
  /** The row's sound is left out. */
  muted?: boolean;
}

export type ItemType = 'video' | 'image' | 'audio' | 'text';

interface BaseItem {
  id: ID;
  trackId: ID;
  /** Position on the timeline, seconds. */
  start: number;
  /** Length on the timeline, seconds. */
  duration: number;
  groupId: ID | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clip an AI result took the place of, so it can be brought back at any time. */
interface Replaced {
  restore?: VideoItem | ImageItem;
}

export interface VideoItem extends BaseItem, Box, Replaced {
  type: 'video';
  assetId: ID;
  /** In-point inside the source media, seconds. */
  trimStart: number;
  speed: number;
  volume: number;
  muted: boolean;
  fadeAudio: boolean;
  opacity: number;
}

export interface ImageItem extends BaseItem, Box, Replaced {
  type: 'image';
  assetId: ID;
  opacity: number;
}

export interface AudioItem extends BaseItem {
  type: 'audio';
  assetId: ID;
  trimStart: number;
  speed: number;
  volume: number;
  muted: boolean;
  fadeAudio: boolean;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Box behind the text; null for none. */
  bgColor: string | null;
  bgPadding: number;
  bgRadius: number;
  /** Outline; null for none. */
  strokeColor: string | null;
  strokeWidth: number;
  shadow: boolean;
}

export interface TextItem extends BaseItem, Box {
  type: 'text';
  text: string;
  style: TextStyle;
  opacity: number;
  /** Subtitle cues are text items that share the project's subtitle style. */
  subtitle: boolean;
}

export type Item = VideoItem | ImageItem | AudioItem | TextItem;
export type MediaItem = VideoItem | AudioItem;
export type VisualItem = VideoItem | ImageItem | TextItem;

export interface ProjectDoc {
  id: ID;
  version: 1;
  name: string;
  settings: ProjectSettings;
  /** Top of the list is the front-most layer. */
  tracks: Track[];
  items: Item[];
}

// ---------------------------------------------------------------- script → video

/** What the writer should aim for when drafting a script from a topic. */
export interface ScriptBrief {
  audience: string;
  videoType: string;
  tone: string;
  platform: string;
}

export type ScriptVisuals = 'background' | 'ai-scenes' | 'talking-character';

export interface ScriptVideoSettings extends ScriptBrief {
  /** What fills the picture: a plain colour, generated scenes, or a talking photo. */
  visuals: ScriptVisuals;
  /** The AI model used for those visuals. */
  visualModelKey: string | null;
  voice: string;
  /** Speaking rate, 1 = normal. */
  rate: number;
  subtitleStyle: string;
  background: string;
  /** Audio asset played quietly under the voice, if any. */
  musicAssetId: ID | null;
  aspect: string;
  targetDuration: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
}

// ---------------------------------------------------------------- rendering

export interface RenderProgress {
  jobId: ID;
  projectId: ID;
  kind: 'export' | 'section';
  state: 'preparing' | 'rendering' | 'finishing' | 'done' | 'error' | 'cancelled';
  /** 0..1 */
  progress: number;
  message?: string;
  /** Set when a section render finished: where the file was saved. */
  outputPath?: string;
}

export interface ImportResult {
  assets: Asset[];
  rejected: { name: string; reason: string }[];
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}
