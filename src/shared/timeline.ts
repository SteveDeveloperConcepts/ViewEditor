// Pure timeline operations. Nothing here touches the DOM, the file system or Electron,
// so the same code drives the editor, the exporter and the unit tests.

import type {
  Asset,
  AudioItem,
  Box,
  ID,
  ImageItem,
  Item,
  MediaItem,
  ProjectDoc,
  ProjectSettings,
  TextItem,
  TextStyle,
  Track,
  VideoItem,
  VisualItem,
} from './types.ts';
import { DEFAULT_CANVAS, DEFAULT_EXPORT_PRESET, DEFAULT_TEXT_STYLE, MIN_ITEM_DURATION } from './constants.ts';
import { newId, snapToFrame } from './time.ts';

export const EPS = 1e-6;

// ---------------------------------------------------------------- basics

export function itemEnd(it: Item): number {
  return it.start + it.duration;
}

export function isVisual(it: Item): it is VisualItem {
  return it.type !== 'audio';
}

export function isTimed(it: Item): it is MediaItem {
  return it.type === 'video' || it.type === 'audio';
}

export function hasAsset(it: Item): it is VideoItem | ImageItem | AudioItem {
  return it.type !== 'text';
}

export function contentEnd(doc: ProjectDoc): number {
  let end = 0;
  for (const it of doc.items) end = Math.max(end, itemEnd(it));
  return end;
}

/** Length of the project: the end of the last element, or the fixed duration from Settings. */
export function projectDuration(doc: ProjectDoc): number {
  if (doc.settings.durationMode === 'fixed') return Math.max(0, doc.settings.fixedDuration);
  return contentEnd(doc);
}

export function itemsOnTrack(doc: ProjectDoc, trackId: ID): Item[] {
  return doc.items.filter((it) => it.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function trackIndex(doc: ProjectDoc, trackId: ID): number {
  return doc.tracks.findIndex((t) => t.id === trackId);
}

export function findItem(doc: ProjectDoc, id: ID): Item | undefined {
  return doc.items.find((it) => it.id === id);
}

/** How long an item may last on the timeline before its source media runs out. */
export function sourceLimit(it: Item, asset: Asset | undefined): number {
  if (!isTimed(it) || !asset || asset.duration <= 0) return Infinity;
  return Math.max(MIN_ITEM_DURATION, (asset.duration - it.trimStart) / it.speed);
}

// ---------------------------------------------------------------- new documents and items

export function defaultSettings(): ProjectSettings {
  return {
    width: DEFAULT_CANVAS.width,
    height: DEFAULT_CANVAS.height,
    autoSize: true,
    fps: 30,
    background: '#000000',
    durationMode: 'auto',
    fixedDuration: 10,
    exportPresetId: DEFAULT_EXPORT_PRESET,
    exportAdvanced: null,
  };
}

export function newProjectDoc(id: ID, name: string): ProjectDoc {
  return { id, version: 1, name, settings: defaultSettings(), tracks: [{ id: newId('trk') }], items: [] };
}

export function fitBox(mw: number, mh: number, cw: number, ch: number, mode: 'contain' | 'cover' = 'contain'): Box {
  if (mw <= 0 || mh <= 0) return { x: 0, y: 0, w: cw, h: ch };
  const s = mode === 'contain' ? Math.min(cw / mw, ch / mh) : Math.max(cw / mw, ch / mh);
  const w = mw * s;
  const h = mh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Canvas size adopted from the first visual media ("Original" size). Long side capped at 3840. */
export function canvasForMedia(w: number, h: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { ...DEFAULT_CANVAS };
  const s = Math.min(1, 3840 / Math.max(w, h));
  return { width: even(w * s), height: even(h * s) };
}

export function makeVideoItem(asset: Asset, doc: ProjectDoc, trackId: ID, start: number): VideoItem {
  const box = fitBox(asset.width, asset.height, doc.settings.width, doc.settings.height);
  return {
    id: newId('itm'), type: 'video', trackId, start, duration: asset.duration, groupId: null,
    assetId: asset.id, trimStart: 0, speed: 1, volume: 1, muted: false, fadeAudio: false, opacity: 1, ...box,
  };
}

export function makeImageItem(asset: Asset, doc: ProjectDoc, trackId: ID, start: number, duration = 5): ImageItem {
  const box = fitBox(asset.width, asset.height, doc.settings.width, doc.settings.height);
  return {
    id: newId('itm'), type: 'image', trackId, start, duration, groupId: null,
    assetId: asset.id, opacity: 1, ...box,
  };
}

export function makeAudioItem(asset: Asset, trackId: ID, start: number): AudioItem {
  return {
    id: newId('itm'), type: 'audio', trackId, start, duration: asset.duration, groupId: null,
    assetId: asset.id, trimStart: 0, speed: 1, volume: 1, muted: false, fadeAudio: false,
  };
}

/** Scale used so text looks the same size on any canvas: styles are authored for a 1080-pixel short side. */
export function canvasTextScale(doc: ProjectDoc): number {
  return Math.min(doc.settings.width, doc.settings.height) / 1080;
}

export function scaleTextStyle(style: TextStyle, s: number): TextStyle {
  return {
    ...style,
    fontSize: Math.max(4, style.fontSize * s),
    bgPadding: style.bgPadding * s,
    bgRadius: style.bgRadius * s,
    strokeWidth: style.strokeWidth * s,
  };
}

export function makeTextItem(
  doc: ProjectDoc,
  trackId: ID,
  start: number,
  text: string,
  style: Partial<TextStyle> = {},
  opts: { duration?: number; subtitle?: boolean } = {},
): TextItem {
  const { width: cw, height: ch } = doc.settings;
  const full = scaleTextStyle({ ...DEFAULT_TEXT_STYLE, ...style }, canvasTextScale(doc));
  const w = cw * 0.8;
  const h = full.fontSize * full.lineHeight;
  const y = opts.subtitle ? ch * 0.86 - h : (ch - h) / 2;
  return {
    id: newId('itm'), type: 'text', trackId, start, duration: opts.duration ?? 5, groupId: null,
    text, style: full, opacity: 1, subtitle: opts.subtitle ?? false,
    x: (cw - w) / 2, y, w, h,
  };
}

// ---------------------------------------------------------------- occupancy

export function rangeFree(doc: ProjectDoc, trackId: ID, start: number, end: number, ignore?: Set<ID>): boolean {
  for (const it of doc.items) {
    if (it.trackId !== trackId || ignore?.has(it.id)) continue;
    if (it.start < end - EPS && itemEnd(it) > start + EPS) return false;
  }
  return true;
}

/** The free stretch around an item on its own track: where its edges may move without overlapping. */
export function neighbourBounds(doc: ProjectDoc, it: Item): { prevEnd: number; nextStart: number } {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const o of doc.items) {
    if (o.trackId !== it.trackId || o.id === it.id) continue;
    if (itemEnd(o) <= it.start + EPS) prevEnd = Math.max(prevEnd, itemEnd(o));
    else if (o.start >= itemEnd(it) - EPS) nextStart = Math.min(nextStart, o.start);
  }
  return { prevEnd, nextStart };
}

/** Closest start time to `desired` where a clip of `duration` fits on the track without overlapping. */
export function nearestFreeStart(doc: ProjectDoc, trackId: ID, desired: number, duration: number, ignore?: Set<ID>): number {
  const taken = doc.items
    .filter((it) => it.trackId === trackId && !ignore?.has(it.id))
    .sort((a, b) => a.start - b.start);
  let best = Infinity;
  let bestDist = Infinity;
  let cursor = 0;
  const consider = (from: number, to: number): void => {
    if (to - from < duration - EPS) return;
    const s = Math.min(Math.max(desired, from), to - duration);
    const d = Math.abs(s - desired);
    if (d < bestDist - EPS) {
      best = s;
      bestDist = d;
    }
  };
  for (const it of taken) {
    consider(cursor, it.start);
    cursor = Math.max(cursor, itemEnd(it));
  }
  consider(cursor, Infinity);
  return Math.max(0, best);
}

/** First track (in the given order) with room for [start, start + duration). */
export function trackWithRoom(doc: ProjectDoc, start: number, duration: number, order: Track[], accept?: (t: Track) => boolean): ID | null {
  for (const t of order) {
    if (accept && !accept(t)) continue;
    if (rangeFree(doc, t.id, start, start + duration)) return t.id;
  }
  return null;
}

// ---------------------------------------------------------------- tracks

export function insertTrack(doc: ProjectDoc, index: number): { doc: ProjectDoc; trackId: ID } {
  const track: Track = { id: newId('trk') };
  const tracks = doc.tracks.slice();
  tracks.splice(Math.max(0, Math.min(index, tracks.length)), 0, track);
  return { doc: { ...doc, tracks }, trackId: track.id };
}

/** Drops tracks that hold nothing, always keeping at least one. */
export function pruneEmptyTracks(doc: ProjectDoc): ProjectDoc {
  const used = new Set(doc.items.map((it) => it.trackId));
  const tracks = doc.tracks.filter((t) => used.has(t.id));
  if (tracks.length === doc.tracks.length || (!tracks.length && doc.tracks.length === 1)) return doc;
  return { ...doc, tracks: tracks.length ? tracks : [doc.tracks[0] ?? { id: newId('trk') }] };
}

// ---------------------------------------------------------------- editing

export function updateItems(doc: ProjectDoc, ids: Iterable<ID>, fn: (it: Item) => Item): ProjectDoc {
  const set = new Set(ids);
  return { ...doc, items: doc.items.map((it) => (set.has(it.id) ? fn(it) : it)) };
}

export function removeItems(doc: ProjectDoc, ids: Iterable<ID>): ProjectDoc {
  const set = new Set(ids);
  return pruneEmptyTracks({ ...doc, items: doc.items.filter((it) => !set.has(it.id)) });
}

/** Cuts an item in two at timeline time `t`. Returns null when `t` is not inside the item. */
export function splitItemAt(it: Item, t: number, rightId: ID): [Item, Item] | null {
  if (t <= it.start + MIN_ITEM_DURATION / 2 || t >= itemEnd(it) - MIN_ITEM_DURATION / 2) return null;
  const left = { ...it, duration: t - it.start } as Item;
  const right = { ...it, id: rightId, start: t, duration: itemEnd(it) - t } as Item;
  if (isTimed(it) && isTimed(right)) right.trimStart = it.trimStart + (t - it.start) * it.speed;
  return [left, right];
}

/** Splits every listed item that the time `t` falls inside. Returns the new doc and the ids of the right-hand halves. */
export function splitAt(doc: ProjectDoc, ids: Iterable<ID>, t: number): { doc: ProjectDoc; created: ID[] } {
  const set = new Set(ids);
  const created: ID[] = [];
  const items: Item[] = [];
  for (const it of doc.items) {
    const parts = set.has(it.id) ? splitItemAt(it, t, newId('itm')) : null;
    if (parts) {
      items.push(parts[0], parts[1]);
      created.push(parts[1].id);
    } else {
      items.push(it);
    }
  }
  return { doc: created.length ? { ...doc, items } : doc, created };
}

/** Moves the start edge of an item (trimming from the left). `asset` bounds how far back the source reaches. */
export function trimStartTo(doc: ProjectDoc, it: Item, newStart: number): Item {
  const { prevEnd } = neighbourBounds(doc, it);
  const end = itemEnd(it);
  let lo = prevEnd;
  if (isTimed(it)) lo = Math.max(lo, it.start - it.trimStart / it.speed);
  const start = Math.min(Math.max(newStart, lo, 0), end - MIN_ITEM_DURATION);
  const next = { ...it, start, duration: end - start } as Item;
  if (isTimed(it) && isTimed(next)) next.trimStart = Math.max(0, it.trimStart + (start - it.start) * it.speed);
  return next;
}

/** Moves the end edge of an item (trimming from the right). */
export function trimEndTo(doc: ProjectDoc, it: Item, newEnd: number, asset: Asset | undefined): Item {
  const { nextStart } = neighbourBounds(doc, it);
  const hi = Math.min(nextStart, it.start + sourceLimit(it, asset));
  const end = Math.max(it.start + MIN_ITEM_DURATION, Math.min(newEnd, hi));
  return { ...it, duration: end - it.start } as Item;
}

/**
 * Puts a video clip's sound on a row of its own, lined up with the clip, and mutes the clip. The row is
 * the first sound-only row below the clip with room, or a new one straight below it.
 */
export function detachAudio(doc: ProjectDoc, itemId: ID, sound: Asset): { doc: ProjectDoc; audioId: ID } | null {
  const it = findItem(doc, itemId);
  if (!it || it.type !== 'video') return null;
  const duration = Math.min(it.duration, (sound.duration - it.trimStart) / it.speed);
  if (duration <= EPS) return null;
  const below = doc.tracks.slice(trackIndex(doc, it.trackId) + 1);
  const home = below.find((t) => {
    const items = itemsOnTrack(doc, t.id);
    return items.length > 0 && items.every((o) => o.type === 'audio') && rangeFree(doc, t.id, it.start, it.start + duration);
  });
  const made = home ? { doc, trackId: home.id } : insertTrack(doc, trackIndex(doc, it.trackId) + 1);
  const audio: AudioItem = { ...makeAudioItem(sound, made.trackId, it.start), duration, trimStart: it.trimStart, speed: it.speed, volume: it.volume, fadeAudio: it.fadeAudio };
  const next = updateItems(made.doc, [it.id], (x) => ({ ...x, muted: true }) as Item);
  return { doc: { ...next, items: [...next.items, audio] }, audioId: audio.id };
}

// ---------------------------------------------------------------- gaps

export interface Gap {
  trackId: ID;
  start: number;
  end: number;
}

/** The empty space on a track under time `t` that sits before some later item, if any. */
export function gapAt(doc: ProjectDoc, trackId: ID, t: number): Gap | null {
  let prevEnd = 0;
  for (const it of itemsOnTrack(doc, trackId)) {
    if (t < it.start - EPS) {
      return it.start - prevEnd > EPS && t >= prevEnd - EPS ? { trackId, start: prevEnd, end: it.start } : null;
    }
    if (t < itemEnd(it)) return null;
    prevEnd = Math.max(prevEnd, itemEnd(it));
  }
  return null;
}

/** Removes an empty space by sliding everything after it on that track to the left. */
export function closeGap(doc: ProjectDoc, gap: Gap): ProjectDoc {
  const len = gap.end - gap.start;
  if (len <= EPS) return doc;
  return {
    ...doc,
    items: doc.items.map((it) =>
      it.trackId === gap.trackId && it.start >= gap.end - EPS ? ({ ...it, start: Math.max(0, it.start - len) } as Item) : it,
    ),
  };
}

// ---------------------------------------------------------------- snapping

export function snapPoints(doc: ProjectDoc, exclude: Set<ID>, extra: number[] = []): number[] {
  const pts = new Set<number>([0, ...extra]);
  for (const it of doc.items) {
    if (exclude.has(it.id)) continue;
    pts.add(it.start);
    pts.add(itemEnd(it));
  }
  return [...pts];
}

/** Snaps `t` to the closest point within `threshold` seconds. */
export function snapValue(t: number, points: number[], threshold: number): { value: number; hit: number | null } {
  let hit: number | null = null;
  let best = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= best) {
      best = d;
      hit = p;
    }
  }
  return { value: hit ?? t, hit };
}

/** Snaps a clip by whichever of its two edges is closest to a snap point. Returns the snapped start. */
export function snapClip(start: number, duration: number, points: number[], threshold: number): { start: number; hit: number | null } {
  const a = snapValue(start, points, threshold);
  const b = snapValue(start + duration, points, threshold);
  const da = a.hit === null ? Infinity : Math.abs(a.hit - start);
  const db = b.hit === null ? Infinity : Math.abs(b.hit - (start + duration));
  if (da === Infinity && db === Infinity) return { start, hit: null };
  return da <= db ? { start: a.value, hit: a.hit } : { start: b.value - duration, hit: b.hit };
}

// ---------------------------------------------------------------- groups

/** Selecting any member of a group selects the whole group. */
export function withGroupMembers(doc: ProjectDoc, ids: Iterable<ID>): ID[] {
  const set = new Set(ids);
  const groups = new Set<ID>();
  for (const it of doc.items) if (set.has(it.id) && it.groupId) groups.add(it.groupId);
  if (!groups.size) return [...set];
  for (const it of doc.items) if (it.groupId && groups.has(it.groupId)) set.add(it.id);
  return [...set];
}

export function groupItems(doc: ProjectDoc, ids: Iterable<ID>): ProjectDoc {
  const groupId = newId('grp');
  return updateItems(doc, ids, (it) => ({ ...it, groupId }) as Item);
}

export function ungroupItems(doc: ProjectDoc, ids: Iterable<ID>): ProjectDoc {
  return updateItems(doc, withGroupMembers(doc, ids), (it) => ({ ...it, groupId: null }) as Item);
}

// ---------------------------------------------------------------- copies

/** Fresh copies of items (new ids, groups remapped), shifted in time by `delta`. */
export function cloneItems(items: Item[], delta: number): Item[] {
  const groupMap = new Map<ID, ID>();
  return items.map((it) => {
    let groupId: ID | null = null;
    if (it.groupId) {
      if (!groupMap.has(it.groupId)) groupMap.set(it.groupId, newId('grp'));
      groupId = groupMap.get(it.groupId)!;
    }
    return { ...it, id: newId('itm'), start: Math.max(0, it.start + delta), groupId } as Item;
  });
}

/**
 * Puts copies of `items` on the timeline starting at `at`, keeping their relative timing and layer order.
 * Each source track maps to an existing track with room, or to a new track above.
 */
export function pasteItems(doc: ProjectDoc, items: Item[], at: number): { doc: ProjectDoc; ids: ID[] } {
  if (!items.length) return { doc, ids: [] };
  const origin = Math.min(...items.map((it) => it.start));
  const copies = cloneItems(items, at - origin);
  let next = doc;
  const bySource = new Map<ID, Item[]>();
  for (const c of copies) {
    const list = bySource.get(c.trackId) ?? [];
    list.push(c);
    bySource.set(c.trackId, list);
  }
  // Keep the original stacking: handle source tracks from the bottom of the stack to the top,
  // and never place a higher layer below one that was already placed.
  const sourceOrder = [...bySource.keys()].sort((a, b) => trackIndex(doc, b) - trackIndex(doc, a));
  const ids: ID[] = [];
  let ceiling = next.tracks.length;
  for (const src of sourceOrder) {
    const group = bySource.get(src)!;
    const current = next;
    const fits = (trackId: ID): boolean => group.every((c) => rangeFree(current, trackId, c.start, itemEnd(c)));
    const srcIdx = trackIndex(current, src);
    let targetIdx = -1;
    for (let i = Math.min(srcIdx >= 0 ? srcIdx : ceiling - 1, ceiling - 1); i >= 0; i--) {
      if (fits(current.tracks[i].id)) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) {
      next = insertTrack(current, 0).doc;
      targetIdx = 0;
    }
    const target = next.tracks[targetIdx].id;
    ceiling = targetIdx;
    const placed = group.map((c) => ({ ...c, trackId: target }) as Item);
    for (const p of placed) ids.push(p.id);
    next = { ...next, items: [...next.items, ...placed] };
  }
  return { doc: next, ids };
}

// ---------------------------------------------------------------- canvas

/** Changes the canvas size and refits every visual element. */
export function resizeCanvas(doc: ProjectDoc, width: number, height: number, mode: 'fit' | 'fill'): ProjectDoc {
  const ow = doc.settings.width;
  const oh = doc.settings.height;
  if (ow === width && oh === height) return { ...doc, settings: { ...doc.settings, autoSize: false } };
  const s = Math.min(width / ow, height / oh);
  const items = doc.items.map((it): Item => {
    if (!isVisual(it)) return it;
    if (it.type !== 'text') {
      const coversCanvas = it.x <= ow * 0.02 && it.y <= oh * 0.02 && it.x + it.w >= ow * 0.98 && it.y + it.h >= oh * 0.98;
      const filledOneAxis = Math.abs(it.w - ow) < ow * 0.02 || Math.abs(it.h - oh) < oh * 0.02;
      const centred = Math.abs(it.x + it.w / 2 - ow / 2) < ow * 0.02 && Math.abs(it.y + it.h / 2 - oh / 2) < oh * 0.02;
      if (coversCanvas || (filledOneAxis && centred)) {
        return { ...it, ...fitBox(it.w, it.h, width, height, mode === 'fill' ? 'cover' : 'contain') };
      }
    }
    const cx = ((it.x + it.w / 2) / ow) * width;
    const cy = ((it.y + it.h / 2) / oh) * height;
    const w = it.w * s;
    const h = it.h * s;
    const moved = { ...it, x: cx - w / 2, y: cy - h / 2, w, h };
    return moved.type === 'text' ? { ...moved, style: scaleTextStyle(moved.style, s) } : moved;
  });
  return { ...doc, items, settings: { ...doc.settings, width, height, autoSize: false } };
}

// ---------------------------------------------------------------- housekeeping

/** Rounds every time in the document to the frame grid, so edits and export agree to the frame. */
export function quantize(doc: ProjectDoc): ProjectDoc {
  const fps = doc.settings.fps;
  return {
    ...doc,
    items: doc.items.map((it) => {
      const start = snapToFrame(it.start, fps);
      const end = Math.max(start + 1 / fps, snapToFrame(itemEnd(it), fps));
      return start === it.start && end - start === it.duration ? it : ({ ...it, start, duration: end - start } as Item);
    }),
  };
}

export function referencedAssetIds(doc: ProjectDoc): ID[] {
  const ids = new Set<ID>();
  for (const it of doc.items) if (hasAsset(it)) ids.add(it.assetId);
  return [...ids];
}
