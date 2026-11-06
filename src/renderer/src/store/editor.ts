// State of the open project and every editing action. Components read from `useEditor`
// and call the functions below; nothing else changes the document.

import { create } from 'zustand';
import type { AiPlacement } from '@shared/ai';
import { DEFAULT_TEXT_STYLE, MIN_ITEM_DURATION, SUBTITLE_STYLES } from '@shared/constants';
import { snapToFrame } from '@shared/time';
import {
  canvasForMedia,
  canvasTextScale,
  closeGap,
  fitBox,
  type Gap,
  groupItems,
  insertTrack,
  isTimed,
  isVisual,
  itemEnd,
  makeAudioItem,
  makeImageItem,
  makeTextItem,
  makeVideoItem,
  nearestFreeStart,
  neighbourBounds,
  pasteItems,
  projectDuration,
  pruneEmptyTracks,
  quantize,
  rangeFree,
  removeItems,
  resizeCanvas,
  scaleTextStyle,
  sourceLimit,
  splitAt,
  ungroupItems,
  updateItems,
  withGroupMembers,
} from '@shared/timeline';
import type { Asset, ID, Item, ProjectDoc, ProjectSettings, TextItem, TextStyle, Track } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { textHeight } from '@/lib/textRender';
import { getAssets } from './library';
import { toast } from './ui';

export type PanelId = 'ai' | 'video' | 'image' | 'audio' | 'text' | 'subtitles' | 'brand' | 'settings';

export interface EditorState {
  doc: ProjectDoc | null;
  selection: ID[];
  /** A selected stretch of empty space on a track (it can be deleted to close it). */
  gap: Gap | null;
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  panel: PanelId;
  /** True while the side panel shows the properties of the selected element. */
  inspecting: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  /** Timeline time a dragged edge is currently snapped to, for the guide line. */
  snapTime: number | null;
  /** Where a new track would be created if the dragged clip were dropped now. */
  newTrackHint: 'top' | 'bottom' | null;
}

const initial: EditorState = {
  doc: null,
  selection: [],
  gap: null,
  playhead: 0,
  playing: false,
  pxPerSec: 80,
  panel: 'video',
  inspecting: false,
  canUndo: false,
  canRedo: false,
  saveState: 'saved',
  snapTime: null,
  newTrackHint: null,
};

export const useEditor = create<EditorState>(() => initial);

const HISTORY_LIMIT = 120;
let past: ProjectDoc[] = [];
let future: ProjectDoc[] = [];
let gestureBase: ProjectDoc | null = null;
let lastCoalesce: { key: string; at: number } | null = null;
let savedDoc: ProjectDoc | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let clipboard: Item[] = [];

const get = useEditor.getState;
const set = useEditor.setState;

function requireDoc(): ProjectDoc {
  const doc = get().doc;
  if (!doc) throw new Error('No project is open.');
  return doc;
}

// ---------------------------------------------------------------- saving

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 800);
}

/** Writes pending changes now. Projects save themselves; this just makes it happen immediately. */
export function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saving = saving.then(async () => {
    const doc = get().doc;
    if (!doc) return;
    if (doc === savedDoc) {
      // Undo and redo can land back on exactly what is on disk: nothing to write, but no longer unsaved.
      set({ saveState: 'saved' });
      return;
    }
    set({ saveState: 'saving' });
    try {
      await api.library.saveProject(doc);
      savedDoc = doc;
      set({ saveState: get().doc === doc ? 'saved' : 'dirty' });
    } catch (err) {
      set({ saveState: 'error' });
      toast(`Could not save the project: ${errorMessage(err)}`, { kind: 'error' });
    }
  });
  return saving;
}

// ---------------------------------------------------------------- document changes

function commit(next: ProjectDoc): void {
  const ids = new Set(next.items.map((it) => it.id));
  const s = get();
  const selection = s.selection.filter((id) => ids.has(id));
  set({
    doc: next,
    selection,
    gap: null,
    inspecting: s.inspecting && selection.length > 0,
    canUndo: past.length > 0 || gestureBase !== null,
    canRedo: future.length > 0,
    saveState: 'dirty',
  });
  scheduleSave();
}

/**
 * Applies a change to the document as one undo step. Changes that share a `coalesce` key and
 * follow each other closely (dragging a slider, typing) fold into a single step.
 */
export function apply(mutate: (doc: ProjectDoc) => ProjectDoc, opts: { coalesce?: string } = {}): void {
  const doc = get().doc;
  if (!doc) return;
  const next = mutate(doc);
  if (next === doc) return;
  if (!gestureBase) {
    const now = Date.now();
    const merge = !!opts.coalesce && lastCoalesce?.key === opts.coalesce && now - lastCoalesce.at < 1200;
    if (!merge) {
      past.push(doc);
      if (past.length > HISTORY_LIMIT) past.shift();
    }
    future = [];
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
  }
  commit(next);
}

/** Starts a drag: everything applied until endGesture becomes a single undo step. */
export function beginGesture(): void {
  gestureBase = get().doc;
  lastCoalesce = null;
}

export function endGesture(opts: { snapToFrames?: boolean } = {}): void {
  const base = gestureBase;
  gestureBase = null;
  set({ snapTime: null, newTrackHint: null });
  const doc = get().doc;
  if (!base || !doc) return;
  if (doc === base) {
    set({ canUndo: past.length > 0 });
    return;
  }
  past.push(base);
  if (past.length > HISTORY_LIMIT) past.shift();
  future = [];
  commit(opts.snapToFrames ? pruneEmptyTracks(quantize(doc)) : doc);
}

export function cancelGesture(): void {
  const base = gestureBase;
  gestureBase = null;
  set({ snapTime: null, newTrackHint: null });
  if (base && base !== get().doc) commit(base);
}

export function undo(): void {
  const doc = get().doc;
  const previous = past.pop();
  if (!doc || !previous) return;
  future.push(doc);
  lastCoalesce = null;
  commit(previous);
}

export function redo(): void {
  const doc = get().doc;
  const next = future.pop();
  if (!doc || !next) return;
  past.push(doc);
  lastCoalesce = null;
  commit(next);
}

// ---------------------------------------------------------------- open / close

function refitText(it: TextItem): TextItem {
  const h = textHeight(it.text, it.style, it.w);
  if (Math.abs(h - it.h) < 0.01) return it;
  // Subtitles grow upwards so their bottom edge stays put; other text grows downwards.
  return it.subtitle ? { ...it, y: it.y + it.h - h, h } : { ...it, h };
}

export async function openProject(id: ID): Promise<void> {
  const loaded = await api.library.loadProject(id);
  const trackIds = new Set(loaded.tracks.map((t) => t.id));
  const doc: ProjectDoc = {
    ...loaded,
    tracks: loaded.tracks.length ? loaded.tracks : [{ id: 'trk_default' }],
    items: loaded.items.filter((it) => trackIds.has(it.trackId)),
  };
  past = [];
  future = [];
  gestureBase = null;
  lastCoalesce = null;
  savedDoc = doc;
  set({ ...initial, doc, pxPerSec: get().pxPerSec });
}

export async function closeProject(id: ID): Promise<void> {
  await flushSave();
  // Another project may have opened while that save was running; it must not be cleared.
  if (get().doc?.id !== id) return;
  set({ ...initial, pxPerSec: get().pxPerSec });
  savedDoc = null;
  past = [];
  future = [];
}

// ---------------------------------------------------------------- selection

export function select(ids: ID[], opts: { inspect?: boolean } = {}): void {
  const doc = get().doc;
  if (!doc) return;
  const all = withGroupMembers(doc, ids);
  set({ selection: all, gap: null, inspecting: opts.inspect ?? all.length > 0 });
}

/** Click on an element: plain click selects it alone, Ctrl/Cmd-click adds or removes it. */
export function selectItem(id: ID, additive: boolean): void {
  const doc = get().doc;
  if (!doc) return;
  const current = get().selection;
  if (!additive) {
    select([id]);
    return;
  }
  const members = withGroupMembers(doc, [id]);
  select(current.includes(id) ? current.filter((x) => !members.includes(x)) : [...current, ...members]);
}

export function clearSelection(): void {
  if (get().selection.length || get().gap) set({ selection: [], gap: null, inspecting: false });
}

export function selectAll(): void {
  const doc = get().doc;
  if (doc) set({ selection: doc.items.map((it) => it.id), gap: null, inspecting: false });
}

export function selectGap(gap: Gap | null): void {
  set({ gap, selection: [], inspecting: false });
}

export function selectedItems(): Item[] {
  const s = get();
  const ids = new Set(s.selection);
  return s.doc ? s.doc.items.filter((it) => ids.has(it.id)) : [];
}

// ---------------------------------------------------------------- adding things

const trackItems = (doc: ProjectDoc, t: Track): Item[] => doc.items.filter((it) => it.trackId === t.id);
const audioOnly = (doc: ProjectDoc, t: Track): boolean => {
  const items = trackItems(doc, t);
  return items.length > 0 && items.every((it) => it.type === 'audio');
};
const hasVideo = (doc: ProjectDoc, t: Track): boolean => trackItems(doc, t).some((it) => it.type === 'video');

/** The layer an overlay (image or text) should go on: above all footage, re-using a track when it has room. */
function overlayTrack(doc: ProjectDoc, start: number, duration: number, accept: (t: Track) => boolean): { doc: ProjectDoc; trackId: ID } {
  const topVideo = doc.tracks.findIndex((t) => hasVideo(doc, t));
  const limit = topVideo < 0 ? doc.tracks.length : topVideo;
  for (let i = 0; i < limit; i++) {
    const t = doc.tracks[i];
    if (!audioOnly(doc, t) && accept(t) && rangeFree(doc, t.id, start, start + duration)) return { doc, trackId: t.id };
  }
  return insertTrack(doc, 0);
}

export interface Placement {
  trackId?: ID;
  newTrack?: 'top' | 'bottom';
  at?: number;
}

/**
 * Puts an asset on the timeline. Without an explicit placement: videos queue up after the footage
 * already there, images go on a layer above it at the playhead, audio goes underneath at the playhead.
 */
export function addAsset(asset: Asset, where: Placement = {}): ID | null {
  let created: Item | null = null;
  apply((before) => {
    let doc = before;
    if (asset.kind !== 'audio' && doc.settings.autoSize) {
      // The first picture or video decides the canvas size.
      const size = canvasForMedia(asset.width, asset.height);
      doc = resizeCanvas(doc, size.width, size.height, 'fit');
    }
    const fps = doc.settings.fps;
    const playhead = snapToFrame(get().playhead, fps);
    const duration = asset.kind === 'image' ? 5 : Math.max(MIN_ITEM_DURATION, asset.duration);
    let trackId: ID;
    let start: number;

    if (where.trackId || where.newTrack) {
      if (where.newTrack) {
        const made = insertTrack(doc, where.newTrack === 'top' ? 0 : doc.tracks.length);
        doc = made.doc;
        trackId = made.trackId;
      } else {
        trackId = where.trackId!;
      }
      start = nearestFreeStart(doc, trackId, Math.max(0, snapToFrame(where.at ?? playhead, fps)), duration);
    } else if (asset.kind === 'video') {
      const main = [...doc.tracks].reverse().find((t) => hasVideo(doc, t));
      const empty = doc.tracks.find((t) => trackItems(doc, t).length === 0);
      if (main) {
        trackId = main.id;
        start = Math.max(0, ...trackItems(doc, main).map(itemEnd));
      } else if (empty) {
        trackId = empty.id;
        start = 0;
      } else {
        // Below the overlays, above any audio-only tracks.
        let index = doc.tracks.length;
        while (index > 0 && audioOnly(doc, doc.tracks[index - 1])) index--;
        const made = insertTrack(doc, index);
        doc = made.doc;
        trackId = made.trackId;
        start = 0;
      }
    } else if (asset.kind === 'audio') {
      const home = [...doc.tracks].reverse().find((t) => (audioOnly(doc, t) || trackItems(doc, t).length === 0) && rangeFree(doc, t.id, playhead, playhead + duration));
      if (home) trackId = home.id;
      else {
        const made = insertTrack(doc, doc.tracks.length);
        doc = made.doc;
        trackId = made.trackId;
      }
      start = playhead;
    } else {
      const placed = overlayTrack(doc, playhead, duration, () => true);
      doc = placed.doc;
      trackId = placed.trackId;
      start = playhead;
    }

    let item: Item =
      asset.kind === 'video' ? makeVideoItem(asset, doc, trackId, start) : asset.kind === 'image' ? makeImageItem(asset, doc, trackId, start, duration) : makeAudioItem(asset, trackId, start);
    if (item.type === 'image' && doc.items.some((it) => isVisual(it) && it.start < start + duration && itemEnd(it) > start)) {
      // Over existing footage an image is usually a logo or an insert: keep it modest, not frame-filling.
      const { width: cw, height: ch } = doc.settings;
      const box = fitBox(asset.width, asset.height, Math.min(cw * 0.4, asset.width), Math.min(ch * 0.4, asset.height));
      item = { ...item, w: box.w, h: box.h, x: (cw - box.w) / 2, y: (ch - box.h) / 2 };
    }
    created = item;
    return pruneEmptyTracks(quantize({ ...doc, items: [...doc.items, item] }));
  });
  const item = created as Item | null;
  if (!item) return null;
  select([item.id], { inspect: false });
  return item.id;
}

export type TextKind = 'heading' | 'subheading' | 'body';

const TEXT_KINDS: Record<TextKind, { text: string; style: Partial<TextStyle> }> = {
  heading: { text: 'Your heading', style: { fontSize: 110, bold: true } },
  subheading: { text: 'Your subheading', style: { fontSize: 70, bold: true } },
  body: { text: 'Your text goes here', style: { fontSize: 46, bold: false } },
};

export function addText(kind: TextKind, style: Partial<TextStyle> = {}): ID | null {
  let id: ID | null = null;
  apply((before) => {
    const playhead = snapToFrame(get().playhead, before.settings.fps);
    const placed = overlayTrack(before, playhead, 5, () => true);
    const preset = TEXT_KINDS[kind];
    let item = makeTextItem(placed.doc, placed.trackId, playhead, preset.text, { ...preset.style, ...style });
    item = refitText(item);
    item = { ...item, y: (placed.doc.settings.height - item.h) / 2 };
    id = item.id;
    return { ...placed.doc, items: [...placed.doc.items, item] };
  });
  if (id) select([id]);
  return id;
}

// ---------------------------------------------------------------- subtitles

function subtitleTrack(doc: ProjectDoc): { doc: ProjectDoc; trackId: ID } {
  const existing = doc.tracks.find((t) => {
    const items = trackItems(doc, t);
    return items.length > 0 && items.every((it) => it.type === 'text' && it.subtitle);
  });
  return existing ? { doc, trackId: existing.id } : insertTrack(doc, 0);
}

function presetStyle(doc: ProjectDoc, presetId: string): TextStyle {
  const preset = SUBTITLE_STYLES.find((p) => p.id === presetId) ?? SUBTITLE_STYLES[0];
  return scaleTextStyle({ ...DEFAULT_TEXT_STYLE, ...preset.style }, canvasTextScale(doc));
}

/** The look subtitles currently have in this project: that of the existing cues, or the default preset. */
export function currentSubtitleStyle(doc: ProjectDoc): TextStyle {
  const cue = doc.items.find((it): it is TextItem => it.type === 'text' && it.subtitle);
  return cue ? cue.style : presetStyle(doc, SUBTITLE_STYLES[0].id);
}

function makeCue(doc: ProjectDoc, trackId: ID, start: number, duration: number, text: string, style: TextStyle): TextItem {
  const { width: cw, height: ch } = doc.settings;
  const w = cw * 0.84;
  const base = makeTextItem(doc, trackId, start, text, {}, { duration, subtitle: true });
  const h = textHeight(text, style, w);
  return { ...base, style, w, h, x: (cw - w) / 2, y: ch * 0.92 - h };
}

/** Adds subtitle cues. Cues that would overlap an existing one on the subtitle track are shortened to fit. */
export function addSubtitles(cues: { start: number; end: number; text: string }[]): ID[] {
  const ids: ID[] = [];
  apply((before) => {
    const placed = subtitleTrack(before);
    let doc = placed.doc;
    const style = currentSubtitleStyle(doc);
    const fps = doc.settings.fps;
    for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
      const text = cue.text.trim();
      const start = Math.max(0, snapToFrame(cue.start, fps));
      let end = snapToFrame(cue.end, fps);
      if (!text || end - start < 1 / fps) continue;
      for (const other of doc.items) {
        if (other.trackId === placed.trackId && other.start > start - 1e-6 && other.start < end) end = other.start;
      }
      if (end - start < 1 / fps || !rangeFree(doc, placed.trackId, start, end)) continue;
      const item = makeCue(doc, placed.trackId, start, end - start, text, style);
      ids.push(item.id);
      doc = { ...doc, items: [...doc.items, item] };
    }
    return ids.length ? doc : before;
  });
  return ids;
}

export function applySubtitlePreset(presetId: string): void {
  apply((doc) => {
    const style = presetStyle(doc, presetId);
    return { ...doc, items: doc.items.map((it) => (it.type === 'text' && it.subtitle ? refitText({ ...it, style }) : it)) };
  });
}

// ---------------------------------------------------------------- editing

export function updateItem(id: ID, patch: Partial<Item>, coalesce?: string): void {
  apply((doc) => updateItems(doc, [id], (it) => ({ ...it, ...patch }) as Item), { coalesce: coalesce ? `${coalesce}:${id}` : undefined });
}

/** Changes a text element and re-measures it, since its height follows its content. */
export function updateText(id: ID, patch: { text?: string; style?: Partial<TextStyle>; w?: number; opacity?: number }, coalesce?: string): void {
  apply(
    (doc) =>
      updateItems(doc, [id], (it) => {
        if (it.type !== 'text') return it;
        const { style, ...rest } = patch;
        return refitText({ ...it, ...rest, style: style ? { ...it.style, ...style } : it.style });
      }),
    { coalesce: coalesce ? `${coalesce}:${id}` : undefined },
  );
}

/** Playback speed. The clip keeps showing the same footage, so its length on the timeline changes. */
export function setSpeed(id: ID, speed: number): void {
  apply((doc) =>
    updateItems(doc, [id], (it) => {
      if (!isTimed(it)) return it;
      const s = Math.max(0.25, Math.min(4, speed));
      const { nextStart } = neighbourBounds(doc, it);
      const footage = it.duration * it.speed;
      const duration = Math.max(MIN_ITEM_DURATION, Math.min(footage / s, nextStart - it.start));
      return { ...it, speed: s, duration: snapToFrame(duration, doc.settings.fps) || duration };
    }),
  );
}

export function fitItem(id: ID, mode: 'contain' | 'cover'): void {
  apply((doc) =>
    updateItems(doc, [id], (it) => {
      if (it.type !== 'video' && it.type !== 'image') return it;
      const asset = getAssets()[it.assetId];
      return { ...it, ...fitBox(asset?.width ?? it.w, asset?.height ?? it.h, doc.settings.width, doc.settings.height, mode) };
    }),
  );
}

/** Swaps the media behind a clip, keeping its place on the timeline and on the canvas where possible. */
export function replaceMedia(id: ID, asset: Asset): void {
  apply((doc) =>
    updateItems(doc, [id], (it) => {
      if (it.type === 'text') return it;
      if (it.type === 'audio') {
        if (asset.kind !== 'audio') return it;
        return { ...it, assetId: asset.id, trimStart: 0, duration: Math.min(it.duration, asset.duration / it.speed) };
      }
      if (asset.kind === 'audio') return it;
      const box = fitBox(asset.width, asset.height, it.w, it.h, 'contain');
      const placed = { x: it.x + box.x, y: it.y + box.y, w: box.w, h: box.h };
      if (asset.kind === 'image') {
        return { id: it.id, type: 'image', trackId: it.trackId, start: it.start, duration: it.duration, groupId: it.groupId, assetId: asset.id, opacity: it.opacity, ...placed };
      }
      const prior = it.type === 'video' ? it : null;
      const speed = prior?.speed ?? 1;
      return {
        id: it.id, type: 'video', trackId: it.trackId, start: it.start, groupId: it.groupId, assetId: asset.id, opacity: it.opacity,
        trimStart: 0, speed, volume: prior?.volume ?? 1, muted: prior?.muted ?? false, fadeAudio: prior?.fadeAudio ?? false,
        duration: Math.min(it.duration, asset.duration / speed), ...placed,
      };
    }),
  );
}

/**
 * Puts a finished AI generation in its place. Unlike replacing media by hand, the new clip keeps
 * its own length and natural speed: it is a different take, not the same footage.
 */
export function placeGenerated(asset: Asset, placement: AiPlacement): void {
  const doc = get().doc;
  if (!doc) return;
  if (placement.kind === 'none') return;
  if (placement.kind === 'timeline') {
    addAsset(asset);
    return;
  }

  if (placement.kind === 'after') {
    const item = doc.items.find((it) => it.id === placement.itemId);
    addAsset(asset, item ? { trackId: item.trackId, at: itemEnd(item) } : {});
    return;
  }

  if (placement.kind === 'replace') {
    const original = doc.items.find((it) => it.id === placement.itemId);
    // The original may have been deleted while the job ran; the result must not vanish with it.
    if (!original || original.type === 'text' || original.type === 'audio' || asset.kind === 'audio') {
      addAsset(asset);
      return;
    }
    apply((d) =>
      updateItems(d, [original.id], (it) => {
        if (it.type !== 'video' && it.type !== 'image') return it;
        const { nextStart } = neighbourBounds(d, it);
        const room = nextStart - it.start;
        const box = fitBox(asset.width, asset.height, it.w, it.h, 'contain');
        const placed = { x: it.x + box.x, y: it.y + box.y, w: box.w, h: box.h };
        if (asset.kind === 'image') {
          return { id: it.id, type: 'image', trackId: it.trackId, start: it.start, duration: it.duration, groupId: it.groupId, assetId: asset.id, opacity: it.opacity, ...placed };
        }
        const prior = it.type === 'video' ? it : null;
        return {
          id: it.id, type: 'video', trackId: it.trackId, start: it.start, groupId: it.groupId, assetId: asset.id, opacity: it.opacity,
          trimStart: 0, speed: 1, volume: prior?.volume ?? 1, muted: prior?.muted ?? false, fadeAudio: prior?.fadeAudio ?? false,
          duration: Math.min(asset.duration, room), ...placed,
        };
      }),
    );
    return;
  }

  // A scene fills a stretch of the timeline. Footage that is too short is slowed a little to fit.
  apply((before) => {
    let next = before;
    let { trackId } = placement;
    if (!next.tracks.some((t) => t.id === trackId)) {
      const made = insertTrack(next, Math.min(1, next.tracks.length));
      next = made.doc;
      trackId = made.trackId;
    }
    const { width, height } = next.settings;
    const box = fitBox(asset.width, asset.height, width, height, 'cover');
    let item: Item;
    if (asset.kind === 'video') {
      const speed = asset.duration >= placement.duration ? 1 : Math.max(0.5, asset.duration / placement.duration);
      const duration = Math.min(placement.duration, asset.duration / speed);
      item = { ...makeVideoItem(asset, next, trackId, placement.start), ...box, duration, speed, muted: placement.muted };
    } else {
      item = { ...makeImageItem(asset, next, trackId, placement.start, placement.duration), ...box };
    }
    const start = nearestFreeStart(next, trackId, placement.start, item.duration);
    return quantize({ ...next, items: [...next.items, { ...item, start } as Item] });
  });
}

export function deleteSelection(): void {
  const { selection, gap } = get();
  if (gap) {
    apply((doc) => closeGap(doc, gap));
    return;
  }
  if (selection.length) apply((doc) => removeItems(doc, selection));
}

/**
 * Cuts at the playhead: the selected clips if the playhead is over one of them, otherwise whatever is
 * under the playhead. When there is nothing to cut, it says so.
 */
export function splitAtPlayhead(): boolean {
  const s = get();
  const doc = s.doc;
  if (!doc) return false;
  const t = snapToFrame(s.playhead, doc.settings.fps);
  const under = doc.items.filter((it) => it.start < t && itemEnd(it) > t).map((it) => it.id);
  const chosen = under.filter((id) => s.selection.includes(id));
  let did = false;
  apply((d) => {
    const result = splitAt(d, chosen.length ? chosen : under, t);
    did = result.created.length > 0;
    return result.doc;
  });
  if (!did) toast('There is no clip under the playhead to split. Move the playhead onto a clip first.');
  return did;
}

export function copySelection(): boolean {
  const items = selectedItems();
  if (!items.length) return false;
  clipboard = items.map((it) => ({ ...it }));
  return true;
}

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

export function paste(at?: number): void {
  if (!clipboard.length) return;
  let ids: ID[] = [];
  apply((doc) => {
    const known = getAssets();
    const usable = clipboard.filter((it) => it.type === 'text' || known[it.assetId]);
    const result = pasteItems(doc, usable, snapToFrame(at ?? get().playhead, doc.settings.fps));
    ids = result.ids;
    return result.doc;
  });
  if (ids.length) select(ids, { inspect: false });
}

/** Copies of the selection, placed right after it. */
export function duplicateSelection(): void {
  const items = selectedItems();
  if (!items.length) return;
  let ids: ID[] = [];
  apply((doc) => {
    const result = pasteItems(doc, items, Math.max(...items.map(itemEnd)));
    ids = result.ids;
    return result.doc;
  });
  if (ids.length) select(ids, { inspect: false });
}

export function groupSelection(): void {
  const ids = get().selection;
  if (ids.length > 1) apply((doc) => groupItems(doc, ids));
}

export function ungroupSelection(): void {
  const ids = get().selection;
  if (ids.length) apply((doc) => ungroupItems(doc, ids));
}

/** True when the whole selection is exactly one group. */
export function selectionIsGroup(doc: ProjectDoc, selection: ID[]): boolean {
  if (selection.length < 2) return false;
  const set = new Set(selection);
  const groups = new Set(doc.items.filter((it) => set.has(it.id)).map((it) => it.groupId));
  return groups.size === 1 && !groups.has(null);
}

export function selectionHasGroup(doc: ProjectDoc, selection: ID[]): boolean {
  const set = new Set(selection);
  return doc.items.some((it) => set.has(it.id) && it.groupId);
}

// ---------------------------------------------------------------- project settings

export function updateSettings(patch: Partial<ProjectSettings>, coalesce?: string): void {
  apply((doc) => ({ ...doc, settings: { ...doc.settings, ...patch } }), { coalesce });
}

export function setCanvasSize(width: number, height: number, mode: 'fit' | 'fill'): void {
  apply((doc) => {
    const resized = resizeCanvas(doc, width, height, mode);
    return { ...resized, items: resized.items.map((it) => (it.type === 'text' ? refitText(it) : it)) };
  });
}

export function renameProject(name: string): void {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (clean) apply((doc) => (doc.name === clean ? doc : { ...doc, name: clean }));
}

// ---------------------------------------------------------------- view

export function setPanel(panel: PanelId): void {
  set({ panel, inspecting: false });
}

export function setZoom(pxPerSec: number): void {
  set({ pxPerSec: Math.max(0.5, Math.min(600, pxPerSec)) });
}

/** Longest time the playhead can reach: the project length, or the content if that runs longer. */
export function timelineEnd(doc: ProjectDoc): number {
  let end = projectDuration(doc);
  for (const it of doc.items) end = Math.max(end, itemEnd(it));
  return end;
}

export { requireDoc, refitText, sourceLimit };
