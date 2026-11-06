// Connecting to AI video services. This file holds the pure logic: reading what a model can do from its
// published input schema, and turning a user's choices into a valid request. No network, no file system.
//
// Providers publish a JSON schema per model. Reading those at run time, instead of keeping a list here,
// means new models appear without an app update and a retired one simply stops being offered. It also
// means the app can only ever send a duration or ratio that the chosen model accepts.

import type { ID } from './types.ts';

export type AiProviderId = 'fal' | 'runway' | 'replicate';

export type AiTask = 'text-to-video' | 'image-to-video' | 'edit-video' | 'talking-photo' | 'lip-sync' | 'text-to-image';

/** A hint from where the model was listed, used alongside its schema to work out what it does. */
export type AiHint = 'text-to-video' | 'image-to-video' | 'video-to-video' | 'text-to-image' | 'lipsync';

export const AI_TASK_LABELS: Record<AiTask, string> = {
  'text-to-video': 'Text to video',
  'image-to-video': 'Image to video',
  'edit-video': 'Edit a video',
  'talking-photo': 'Talking photo',
  'lip-sync': 'Lip-sync',
  'text-to-image': 'Text to image',
};

export type AiValue = string | number;

/** A setting the model offers: either a fixed list of values, or a numeric range. */
export interface AiOption {
  field: string;
  values: AiValue[] | null;
  min: number | null;
  max: number | null;
  default: AiValue | null;
  required: boolean;
}

export interface AiMediaField {
  field: string;
  /** The field takes a list, even though only one file is sent. */
  list: boolean;
  required: boolean;
}

export interface AiModel {
  /** Unique across providers and tasks. */
  key: string;
  provider: AiProviderId;
  /** The provider's name for the model. */
  id: string;
  /** Where requests for this model go, in the provider's own terms. */
  endpoint: string;
  task: AiTask;
  label: string;
  description: string;
  prompt: { field: string; required: boolean; maxLength: number | null } | null;
  image: AiMediaField | null;
  video: AiMediaField | null;
  audio: AiMediaField | null;
  duration: AiOption | null;
  aspect: AiOption | null;
  resolution: AiOption | null;
  /** On/off switch for sound generated with the video. */
  sound: { field: string; default: boolean } | null;
  /** Values the model requires that the user is not asked about. */
  fixed: Record<string, unknown>;
}

// ---------------------------------------------------------------- reading schemas

export type JsonSchema = Record<string, unknown>;
type Deref = (node: unknown) => JsonSchema | undefined;

const asSchema = (n: unknown): JsonSchema | undefined => (n && typeof n === 'object' ? (n as JsonSchema) : undefined);

/** Follows `$ref` pointers inside a document. */
export function refResolver(root: unknown): Deref {
  const follow: Deref = (node) => {
    const n = asSchema(node);
    const ref = n?.$ref;
    if (typeof ref !== 'string') return n;
    const target = ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((o, key) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined), root);
    return follow(target);
  };
  return follow;
}

interface Flat {
  types: Set<string>;
  values: AiValue[];
  min: number | null;
  max: number | null;
  maxLength: number | null;
  items: unknown;
  default: unknown;
}

/** Collapses `anyOf`, `oneOf` and `allOf` into one description, ignoring "or null". */
function flatten(node: unknown, deref: Deref, acc?: Flat): Flat {
  const out: Flat = acc ?? { types: new Set(), values: [], min: null, max: null, maxLength: null, items: undefined, default: undefined };
  const n = deref(node);
  if (!n) return out;
  if (n.default !== undefined && out.default === undefined) out.default = n.default;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const parts = n[key];
    if (Array.isArray(parts)) for (const part of parts) flatten(part, deref, out);
  }
  const typeOf = n.type;
  for (const t of Array.isArray(typeOf) ? typeOf : [typeOf]) if (typeof t === 'string' && t !== 'null') out.types.add(t);
  if (Array.isArray(n.enum)) {
    for (const v of n.enum) if ((typeof v === 'string' || typeof v === 'number') && !out.values.includes(v)) out.values.push(v);
  }
  if ('const' in n && (typeof n.const === 'string' || typeof n.const === 'number') && !out.values.includes(n.const)) out.values.push(n.const);
  if (typeof n.minimum === 'number') out.min = out.min === null ? n.minimum : Math.min(out.min, n.minimum);
  if (typeof n.maximum === 'number') out.max = out.max === null ? n.maximum : Math.max(out.max, n.maximum);
  if (typeof n.maxLength === 'number') out.maxLength = Math.max(out.maxLength ?? 0, n.maxLength);
  if (n.items !== undefined && out.items === undefined) out.items = n.items;
  return out;
}

const PROMPT_FIELDS = ['prompt', 'promptText', 'text_prompt'];
const IMAGE_FIELDS = ['start_image_url', 'image_url', 'first_frame_url', 'first_frame_image', 'start_image', 'first_frame', 'input_image', 'promptImage', 'image'];
const VIDEO_FIELDS = ['video_url', 'base_video', 'input_video', 'source_video', 'promptVideo', 'videoUri', 'video'];
const AUDIO_FIELDS = ['audio_url', 'input_audio', 'driving_audio', 'audio_file', 'audio'];
const IMAGE_ONLY_FIELDS = ['image_urls', 'reference_image_urls', 'images'];
const DURATION_FIELDS = ['duration', 'duration_seconds', 'seconds'];
const ASPECT_FIELDS = ['aspect_ratio', 'ratio', 'aspect'];
const SOUND_FIELDS = ['generate_audio', 'audio', 'with_audio'];

function pick(props: Record<string, unknown>, names: string[]): string | null {
  return names.find((n) => n in props) ?? null;
}

/** Same letters in a different case are the same choice: some models accept both "720p" and "720P". */
function uniqueValues(values: AiValue[]): AiValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = String(v).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Listed alongside the models, but tools for a pipeline rather than something to make video with. */
const UTILITY = /ffmpeg-api|workflow-utilities|mmaudio|\bsam-\d|upscal|depth-anything|birefnet|background-removal/i;

function optionOf(field: string | null, props: Record<string, unknown>, required: string[], deref: Deref): AiOption | null {
  if (!field) return null;
  const flat = flatten(props[field], deref);
  const numeric = flat.types.has('integer') || flat.types.has('number');
  if (!flat.values.length && !numeric) return null;
  const def = flat.default;
  return {
    field,
    values: flat.values.length && !(numeric && flat.min !== null) ? uniqueValues(flat.values) : null,
    min: numeric ? flat.min : null,
    max: numeric ? flat.max : null,
    default: typeof def === 'string' || typeof def === 'number' ? def : null,
    required: required.includes(field),
  };
}

function mediaOf(names: string[], props: Record<string, unknown>, required: string[], deref: Deref): AiMediaField | null {
  for (const field of names) {
    if (!(field in props)) continue;
    const flat = flatten(props[field], deref);
    // Some models use `audio` as an on/off switch, which is not a file.
    if (flat.types.has('boolean')) continue;
    return { field, list: flat.types.has('array'), required: required.includes(field) };
  }
  return null;
}

export interface ModelMeta {
  provider: AiProviderId;
  id: string;
  endpoint: string;
  label: string;
  description: string;
  hint: AiHint;
}

/**
 * Reads a model's input schema and works out which tasks it can do. Returns one entry per task, or
 * nothing when the model cannot be driven from the app: utilities, or models that need inputs it
 * has no way of asking for.
 */
export function modelsFromSchema(schema: JsonSchema, deref: Deref, meta: ModelMeta): AiModel[] {
  if (UTILITY.test(meta.id)) return [];
  const props = (asSchema(deref(schema)?.properties) ?? {}) as Record<string, unknown>;
  const required = (Array.isArray(schema.required) ? schema.required : []).filter((r): r is string => typeof r === 'string');

  const promptField = pick(props, PROMPT_FIELDS);
  const promptFlat = promptField ? flatten(props[promptField], deref) : null;
  const prompt = promptField ? { field: promptField, required: required.includes(promptField), maxLength: promptFlat?.maxLength ?? null } : null;
  const video = mediaOf(VIDEO_FIELDS, props, required, deref);
  const audio = mediaOf(AUDIO_FIELDS, props, required, deref);
  let image = mediaOf(IMAGE_FIELDS, props, required, deref);
  // A list of images only counts when the model will not run without it.
  if (!image) {
    const listed = mediaOf(IMAGE_ONLY_FIELDS, props, required, deref);
    if (listed?.required) image = listed;
  }

  const duration = optionOf(pick(props, DURATION_FIELDS), props, required, deref);
  const aspect = optionOf(pick(props, ASPECT_FIELDS), props, required, deref);
  const resolution = optionOf('resolution' in props ? 'resolution' : null, props, required, deref);
  const soundField = SOUND_FIELDS.find((n) => n in props && flatten(props[n], deref).types.has('boolean')) ?? null;
  const sound = soundField ? { field: soundField, default: flatten(props[soundField], deref).default === true } : null;

  // Anything else the model insists on has to have a default, or there is no way to fill it in.
  const fixed: Record<string, unknown> = {};
  const known = new Set(
    [prompt?.field, image?.field, video?.field, audio?.field, duration?.field, aspect?.field, resolution?.field, sound?.field, 'model'].filter(Boolean),
  );
  for (const field of required) {
    if (known.has(field)) continue;
    const d = flatten(props[field], deref).default;
    if (d === undefined) return [];
    fixed[field] = d;
  }

  const tasks: AiTask[] = [];
  const hint = meta.hint;
  if (hint === 'text-to-image') {
    if (prompt) tasks.push('text-to-image');
  } else if (audio?.required && video) {
    tasks.push('lip-sync');
  } else if (audio?.required && image) {
    tasks.push('talking-photo');
  } else if (hint === 'lipsync') {
    // Listed under lip-sync but the schema does not say how: leave it out rather than guess.
  } else {
    // Editing means changing a video by describing it. Runway's editors can also work from keyframes,
    // so a prompt is optional there; elsewhere an optional prompt marks a different kind of tool.
    if (video && prompt && !image?.required && (prompt.required || meta.provider === 'runway')) tasks.push('edit-video');
    if (image && hint !== 'video-to-video' && !video?.required) tasks.push('image-to-video');
    if (prompt && hint === 'text-to-video' && !image?.required && !video?.required && !audio?.required) tasks.push('text-to-video');
  }

  return tasks.map((task) => {
    const usesImage = task === 'image-to-video' || task === 'talking-photo';
    const usesVideo = task === 'edit-video' || task === 'lip-sync';
    const usesAudio = task === 'talking-photo' || task === 'lip-sync';
    return {
      key: `${meta.provider}:${task}:${meta.id}`,
      provider: meta.provider,
      id: meta.id,
      endpoint: meta.endpoint,
      task,
      label: meta.label,
      description: meta.description,
      prompt,
      image: usesImage ? image : null,
      video: usesVideo ? video : null,
      audio: usesAudio ? audio : null,
      duration,
      aspect,
      resolution,
      sound,
      fixed,
    };
  });
}

// ---------------------------------------------------------------- options shown to the user

/** Seconds a raw duration value stands for, or null for values like "auto". */
export function durationSeconds(value: AiValue): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

export function durationLabel(value: AiValue): string {
  const n = durationSeconds(value);
  return n === null ? 'Automatic' : `${n} s`;
}

/** The values to offer for a duration. Ranges are thinned out to a handful of useful lengths. */
export function durationChoices(option: AiOption | null): AiValue[] {
  if (!option) return [];
  if (option.values) return option.values;
  const lo = Math.ceil(option.min ?? 1);
  const hi = Math.floor(option.max ?? Math.max(lo, 10));
  const def = typeof option.default === 'number' ? option.default : lo;
  const picks = [lo, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, hi, def].filter((n) => n >= lo && n <= hi);
  return [...new Set(picks)].sort((a, b) => a - b);
}

/** The shortest allowed length that covers `seconds`, or the longest there is. */
export function pickDuration(option: AiOption | null, seconds: number): AiValue | undefined {
  const choices = durationChoices(option).filter((v) => durationSeconds(v) !== null);
  if (!choices.length) return undefined;
  const sorted = [...choices].sort((a, b) => durationSeconds(a)! - durationSeconds(b)!);
  return sorted.find((v) => durationSeconds(v)! >= seconds - 1e-6) ?? sorted[sorted.length - 1];
}

/** Whether a model can make a clip of exactly this length. A model with no length setting decides for itself. */
export function canMake(model: AiModel, seconds: number): boolean {
  const option = model.duration;
  if (!option) return true;
  if (option.values) return option.values.some((v) => durationSeconds(v) === seconds);
  return seconds >= (option.min ?? 0) && seconds <= (option.max ?? Infinity);
}

/** Well-known models for each task, best first. The rest of a service's list stays available under its name. */
const RECOMMENDED: Partial<Record<AiTask, RegExp[]>> = {
  'text-to-video': [/veo.?3/i, /kling/i, /seedance/i, /gen.?4/i, /hailuo|minimax/i],
  'image-to-video': [/kling/i, /veo.?3/i, /seedance/i, /gen.?4/i, /hailuo|minimax/i],
  'text-to-image': [/flux/i, /imagen/i, /gen.?4/i],
  'edit-video': [/aleph/i, /kling/i],
  'talking-photo': [/fabric/i],
  'lip-sync': [/lip.?sync/i],
};

/** A short list to start from: up to three well-known models, preferring ones that can make the length asked for. */
export function recommendedModels(models: AiModel[], task: AiTask, seconds: number | null): AiModel[] {
  const picks: AiModel[] = [];
  const offer = (usable: (m: AiModel) => boolean): void => {
    for (const pattern of RECOMMENDED[task] ?? []) {
      const found = models.find((m) => pattern.test(`${m.label} ${m.id}`) && usable(m) && !picks.includes(m));
      if (found && picks.length < 3) picks.push(found);
    }
  };
  offer((m) => seconds === null || canMake(m, seconds));
  offer(() => true);
  return picks;
}

/** What a clip comes to at a per-second price such as "$0.15 per second". Null for prices of any other kind. */
export function totalPrice(price: string | null, seconds: number | null): string | null {
  const m = price && seconds ? /^(\D*)(\d+(?:\.\d+)?)(\D*?)\s+per\s+(?:second|sec|s)\b/i.exec(price) : null;
  return m ? `${m[1]}${(Number(m[2]) * seconds!).toFixed(2)}${m[3]}` : null;
}

/** Width over height of a raw ratio value such as "16:9" or "1280:720". Null for words like "auto". */
export function ratioOf(value: AiValue): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(String(value));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

const COMMON_RATIOS: [number, string][] = [
  [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [4 / 5, '4:5'], [5 / 4, '5:4'], [3 / 2, '3:2'], [2 / 3, '2:3'], [21 / 9, '21:9'], [9 / 21, '9:21'],
];

export function aspectLabel(value: AiValue): string {
  const text = String(value);
  const r = ratioOf(value);
  if (r === null) return text.includes('auto') || text === 'adaptive' ? 'Match the input' : text;
  const [w, h] = text.split(/[:x]/).map(Number);
  const named = COMMON_RATIOS.find(([n]) => Math.abs(n - r) / n < 0.03)?.[1];
  // Small numbers are already a ratio. Large ones are a frame size as well, so keep both.
  if (w <= 32 && h <= 32) return text;
  return named ? `${named} · ${w} × ${h}` : `${w} × ${h}`;
}

/** The offered ratio closest to a frame of the given shape. */
export function pickAspect(option: AiOption | null, width: number, height: number): AiValue | undefined {
  if (!option?.values?.length) return undefined;
  const target = width / height;
  let best: AiValue | undefined;
  let bestDiff = Infinity;
  for (const v of option.values) {
    const r = ratioOf(v);
    if (r === null) continue;
    const diff = Math.abs(Math.log(r / target));
    // Among equal shapes prefer the larger frame: it is the sharper picture.
    if (diff < bestDiff - 1e-6 || (Math.abs(diff - bestDiff) <= 1e-6 && Number(String(v).split(/[:x]/)[0]) > Number(String(best).split(/[:x]/)[0]))) {
      best = v;
      bestDiff = diff;
    }
  }
  return best ?? option.default ?? option.values[0];
}

// ---------------------------------------------------------------- requests

/** What the user chose for one generation. */
export interface AiChoices {
  prompt?: string;
  duration?: AiValue;
  aspect?: AiValue;
  resolution?: AiValue;
  sound?: boolean;
}

/** Addresses of uploaded input files, as the provider will read them. */
export interface AiInputUrls {
  image?: string;
  video?: string;
  audio?: string;
}

function allowed(option: AiOption | null, value: AiValue | undefined): AiValue | undefined {
  if (!option) return undefined;
  if (value === undefined) return option.required ? (option.default ?? option.values?.[0] ?? option.min ?? undefined) : undefined;
  if (option.values) return option.values.includes(value) ? value : (option.default ?? option.values[0]);
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return option.default ?? undefined;
  return Math.max(option.min ?? -Infinity, Math.min(option.max ?? Infinity, n));
}

/** The request body for a model. Settings it does not have are left out, and values it does not allow are corrected. */
export function buildInputs(model: AiModel, choices: AiChoices, urls: AiInputUrls): Record<string, unknown> {
  const body: Record<string, unknown> = { ...model.fixed };
  const prompt = choices.prompt?.trim();
  if (model.prompt && prompt) body[model.prompt.field] = model.prompt.maxLength ? prompt.slice(0, model.prompt.maxLength) : prompt;
  for (const [field, url] of [[model.image, urls.image], [model.video, urls.video], [model.audio, urls.audio]] as const) {
    if (field && url) body[field.field] = field.list ? [url] : url;
  }
  for (const [option, value] of [[model.duration, choices.duration], [model.aspect, choices.aspect], [model.resolution, choices.resolution]] as const) {
    const v = allowed(option, value);
    if (option && v !== undefined) body[option.field] = v;
  }
  if (model.sound && choices.sound !== undefined) body[model.sound.field] = choices.sound;
  return body;
}

/** What is still missing before a model can run. Returns a message for the user, or null when ready. */
export function missingInput(model: AiModel, choices: AiChoices, has: { image: boolean; video: boolean; audio: boolean }): string | null {
  // Some models mark the prompt optional because they have another way in, which this form does not use.
  const needsPrompt = model.prompt?.required || (model.prompt && ['text-to-video', 'text-to-image', 'edit-video'].includes(model.task));
  if (needsPrompt && !choices.prompt?.trim()) return 'Describe what you want.';
  if (model.image?.required && !has.image) return 'Choose an image first.';
  if (model.video?.required && !has.video) return 'Choose a video first.';
  if (model.audio?.required && !has.audio) return 'Choose some audio first.';
  return null;
}

// ---------------------------------------------------------------- jobs

/** A piece of media sent to a provider. */
export interface AiMediaRef {
  assetId: ID;
  /** For video and sound: the stretch to send, in seconds of the source. */
  start?: number;
  end?: number;
  /** For a still taken from a video: which moment, in seconds of the source. */
  frameAt?: number;
}

/** Sound from Media that goes with a generated clip: which file, and which stretch of it. */
export interface AiSound {
  assetId: ID;
  start: number;
  duration: number;
}

/** What happens to the result once it arrives. */
export type AiPlacement =
  | { kind: 'none' }
  /** Added to the timeline: where the playhead was when asked for, or after the last clip for a `sequence`. `trim` is a length to cut it to. */
  | { kind: 'timeline'; at?: number; sequence?: boolean; sound?: AiSound; trim?: number }
  /** Takes the place of this element, keeping its position. */
  | { kind: 'replace'; itemId: ID }
  /** Goes straight after this element on the same track. */
  | { kind: 'after'; itemId: ID }
  /** Fills a stretch of the timeline on a given track, stretched or cut to fit. */
  | { kind: 'scene'; trackId: ID; start: number; duration: number; muted: boolean };

export type AiJobState = 'preparing' | 'uploading' | 'queued' | 'running' | 'downloading' | 'done' | 'failed' | 'cancelled';

export const AI_ACTIVE_STATES: AiJobState[] = ['preparing', 'uploading', 'queued', 'running', 'downloading'];

export interface AiRemote {
  id: string;
  statusUrl?: string;
  resultUrl?: string;
  cancelUrl?: string;
}

export interface AiRequest {
  modelKey: string;
  choices: AiChoices;
  image?: AiMediaRef | null;
  video?: AiMediaRef | null;
  audio?: AiMediaRef | null;
  target: { scope: 'workspace' | 'project'; projectId?: ID | null };
  placement: AiPlacement;
  /** Short name for the result, when the prompt would not make a good one. */
  name?: string;
}

export interface AiJob {
  id: ID;
  provider: AiProviderId;
  modelKey: string;
  modelLabel: string;
  task: AiTask;
  prompt: string;
  name: string;
  state: AiJobState;
  /** Place in the provider's queue, or how far along it is, when the provider says. */
  queuePosition: number | null;
  progress: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Everything needed to pick the job up again after a restart. */
  remote: AiRemote | null;
  /** Kept so a job can run again without asking for everything a second time. */
  request: AiRequest;
  assetId: ID | null;
  /** True once the result has been put where it was meant to go. */
  applied: boolean;
}

export function isActive(job: AiJob): boolean {
  return AI_ACTIVE_STATES.includes(job.state);
}

export interface AiProviderStatus {
  id: AiProviderId;
  name: string;
  tagline: string;
  keyUrl: string;
  connected: boolean;
  /** Something useful about the account, such as its credit balance. */
  detail: string | null;
}

/** A stretch of speech written down. */
export interface TimedText {
  start: number;
  end: number;
  text: string;
}

// ---------------------------------------------------------------- scenes

export interface ScenePlan {
  start: number;
  end: number;
  /** Indexes of the sentences spoken during this scene. */
  sentences: number[];
}

/**
 * Groups narration into scenes of a sensible length, each to be covered by one generated clip.
 * Scenes meet end to end, so the picture never drops out between sentences.
 */
export function planScenes(timings: { start: number; end: number }[], targetSeconds: number): ScenePlan[] {
  const scenes: ScenePlan[] = [];
  timings.forEach((t, i) => {
    const last = scenes[scenes.length - 1];
    if (last && t.end - last.start <= targetSeconds * 1.25) {
      last.end = t.end;
      last.sentences.push(i);
    } else {
      if (last) last.end = t.start;
      scenes.push({ start: last ? t.start : 0, end: t.end, sentences: [i] });
    }
  });
  return scenes;
}
