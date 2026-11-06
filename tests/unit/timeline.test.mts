import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasForMedia,
  cloneItems,
  closeGap,
  detachAudio,
  fitBox,
  gapAt,
  groupItems,
  insertTrack,
  itemEnd,
  makeAudioItem,
  makeImageItem,
  makeTextItem,
  makeVideoItem,
  moveTrack,
  nearestFreeStart,
  newProjectDoc,
  pasteItems,
  projectDuration,
  pruneEmptyTracks,
  quantize,
  rangeFree,
  removeItems,
  resizeCanvas,
  setSourceRange,
  snapClip,
  snapPoints,
  snapValue,
  splitAt,
  splitItemAt,
  trackNames,
  trimEndTo,
  trimStartTo,
  ungroupItems,
  withGroupMembers,
} from '../../src/shared/timeline.ts';
import type { Asset, Item, ProjectDoc, VideoItem } from '../../src/shared/types.ts';

function asset(patch: Partial<Asset> = {}): Asset {
  return {
    id: 'a1', kind: 'video', name: 'a.mp4', ext: 'mp4', size: 1, createdAt: 0, source: 'upload', scope: 'project', projectId: null,
    duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, audioChannels: 2, hasAlpha: false, isHdr: false,
    videoCodec: 'h264', audioCodec: 'aac', colorMatrix: 'bt709', hasThumb: false, strip: null, hasWave: false,
    proxy: 'none', proxyExt: null, previewChecked: true, raster: 'none', ...patch,
  };
}

function docWith(...items: ((doc: ProjectDoc, track: string) => Item)[]): ProjectDoc {
  const doc = newProjectDoc('p', 'Test');
  doc.items = items.map((make) => make(doc, doc.tracks[0].id));
  return doc;
}

const clipAt = (start: number, duration: number, trimStart = 0) => (doc: ProjectDoc, track: string): VideoItem => ({ ...makeVideoItem(asset(), doc, track, start), duration, trimStart });

test('extracting audio lines the sound up under the clip, and mutes the clip', () => {
  const sound = asset({ id: 'a2', kind: 'audio', duration: 20, width: 0, height: 0 });
  const doc = docWith(clipAt(2, 3, 5));
  const clip = { ...doc.items[0], volume: 0.5 } as VideoItem;
  const result = detachAudio({ ...doc, items: [clip] }, clip.id, sound)!;
  const audio = result.doc.items.find((i) => i.id === result.audioId) as VideoItem;
  assert.equal(audio.type, 'audio');
  assert.deepEqual({ start: audio.start, duration: audio.duration, trimStart: audio.trimStart, volume: audio.volume }, { start: 2, duration: 3, trimStart: 5, volume: 0.5 });
  assert.equal((result.doc.items.find((i) => i.id === clip.id) as VideoItem).muted, true);
  assert.equal(result.doc.tracks.findIndex((t) => t.id === audio.trackId), 1, 'on a row of its own, below the clip');

  const later = clipAt(10, 3)(result.doc, clip.trackId);
  const second = detachAudio({ ...result.doc, items: [...result.doc.items, later] }, later.id, sound)!;
  assert.equal(second.doc.tracks.length, 2, 'an existing sound row with room is used');
});

test('a chosen stretch of sound can go under a clip instead of its own', () => {
  const sound = asset({ id: 'a2', kind: 'audio', duration: 20 });
  const doc = docWith(clipAt(4, 3));
  const result = detachAudio(doc, doc.items[0].id, sound, { start: 5, duration: 3 })!;
  const audio = result.doc.items.find((i) => i.id === result.audioId) as VideoItem;
  assert.deepEqual({ start: audio.start, duration: audio.duration, trimStart: audio.trimStart }, { start: 4, duration: 3, trimStart: 5 });
});

test('extracted sound stops where the file does, and only video has any to give', () => {
  const sound = asset({ id: 'a2', kind: 'audio', duration: 4 });
  const doc = docWith(clipAt(0, 6));
  const result = detachAudio(doc, doc.items[0].id, sound)!;
  assert.equal(result.doc.items.find((i) => i.id === result.audioId)!.duration, 4);
  assert.equal(detachAudio(result.doc, result.audioId, sound), null);
});

test('choosing which part of a file plays keeps the clip where it starts', () => {
  const doc = docWith(clipAt(2, 4, 1), clipAt(8, 2));
  const clip = doc.items[0] as VideoItem;
  const later = setSourceRange(doc, clip, 3, 5, asset());
  assert.deepEqual({ start: later.start, trimStart: later.trimStart, duration: later.duration }, { start: 2, trimStart: 3, duration: 2 });
  assert.equal(setSourceRange(doc, clip, 0, 9, asset()).duration, 6, 'it stops at the next clip');
  assert.equal(setSourceRange(doc, { ...clip, start: 20 }, 9, 30, asset()).duration, 1, 'and at the end of the file');
  assert.equal(setSourceRange(doc, { ...clip, speed: 2 }, 0, 4, asset()).duration, 2, 'and speed is taken into account');
});

test('a piece of a replaced clip no longer offers to restore the whole of it', () => {
  const doc = docWith(clipAt(0, 6));
  const clip = { ...doc.items[0], restore: doc.items[0] } as VideoItem;
  const parts = splitItemAt(clip, 2, 'right')!;
  assert.ok(parts.every((p) => !('restore' in p)));
});

test('rows are named after what is on them, and your own names win', () => {
  const doc = docWith(clipAt(0, 5));
  const upper = insertTrack(doc, 0);
  const lower = insertTrack(upper.doc, 2);
  const three = { ...lower.doc, items: [...lower.doc.items, clipAt(0, 5)(lower.doc, upper.trackId), makeAudioItem(asset({ kind: 'audio' }), lower.trackId, 0)] };
  const names = trackNames(three);
  assert.equal(names.get(upper.trackId), 'Video 2', 'numbered from the bottom');
  assert.equal(names.get(three.tracks[1].id), 'Video 1');
  assert.equal(names.get(lower.trackId), 'Audio');
  const own = { ...three, tracks: three.tracks.map((t) => (t.id === upper.trackId ? { ...t, name: 'B-roll' } : t)) };
  assert.equal(trackNames(own).get(upper.trackId), 'B-roll');
});

test('a row can move up and down, but not off the ends', () => {
  const doc = docWith(clipAt(0, 5));
  const two = insertTrack(doc, 0);
  assert.equal(moveTrack(two.doc, two.trackId, 1).tracks[1].id, two.trackId);
  assert.equal(moveTrack(two.doc, two.trackId, -1), two.doc);
});

test('project length is the end of the last element unless fixed', () => {
  const doc = docWith(clipAt(0, 4), clipAt(6, 2));
  assert.equal(projectDuration(doc), 8);
  doc.settings.durationMode = 'fixed';
  doc.settings.fixedDuration = 5;
  assert.equal(projectDuration(doc), 5);
});

test('splitting keeps the footage continuous, also at other speeds', () => {
  const doc = docWith(clipAt(2, 6, 1));
  const v = doc.items[0] as VideoItem;
  const [left, right] = splitItemAt({ ...v, speed: 2 }, 5, 'r')! as [VideoItem, VideoItem];
  assert.equal(left.duration, 3);
  assert.equal(right.start, 5);
  assert.equal(right.duration, 3);
  assert.equal(right.trimStart, 1 + 3 * 2);
  assert.equal(right.id, 'r');
});

test('splitting outside an element does nothing', () => {
  const doc = docWith(clipAt(2, 6));
  assert.equal(splitItemAt(doc.items[0], 2, 'r'), null);
  assert.equal(splitItemAt(doc.items[0], 8, 'r'), null);
  assert.equal(splitAt(doc, [doc.items[0].id], 1).doc, doc);
});

test('splitAt only cuts the listed elements', () => {
  const doc = docWith(clipAt(0, 4));
  const other = { ...makeVideoItem(asset(), doc, 'other', 0), duration: 4 };
  doc.items.push(other);
  const { doc: next, created } = splitAt(doc, [doc.items[0].id], 2);
  assert.equal(created.length, 1);
  assert.equal(next.items.length, 3);
  assert.equal(next.items.find((i) => i.id === other.id)!.duration, 4);
});

test('trimming the start moves the in-point and cannot reach before the footage', () => {
  const doc = docWith(clipAt(5, 3, 2));
  const v = doc.items[0] as VideoItem;
  const later = trimStartTo(doc, v, 6) as VideoItem;
  assert.deepEqual([later.start, later.duration, later.trimStart], [6, 2, 3]);
  const earliest = trimStartTo(doc, v, 0) as VideoItem;
  assert.deepEqual([earliest.start, earliest.trimStart], [3, 0], 'only two seconds of earlier footage exist');
});

test('trimming stops at the neighbouring element and at the end of the source', () => {
  const doc = docWith(clipAt(0, 2), clipAt(3, 2));
  const [first, second] = doc.items as VideoItem[];
  assert.equal(trimEndTo(doc, first, 9, asset()).duration, 3, 'stops at the next clip');
  assert.equal(trimStartTo(doc, second, 0).start, 3, 'stops at the footage start');
  const lone = docWith(clipAt(0, 2));
  assert.equal(trimEndTo(lone, lone.items[0], 100, asset({ duration: 10 })).duration, 10, 'stops at the end of the media');
  const fast = { ...(lone.items[0] as VideoItem), speed: 2 };
  assert.equal(trimEndTo(lone, fast, 100, asset({ duration: 10 })).duration, 5, 'at 2x, ten seconds of footage last five');
});

test('images and text can be stretched without limit', () => {
  const doc = newProjectDoc('p', 'Test');
  const img = makeImageItem(asset({ kind: 'image', duration: 0 }), doc, doc.tracks[0].id, 0, 3);
  doc.items = [img];
  assert.equal(trimEndTo(doc, img, 500, undefined).duration, 500);
});

test('empty space is found only between elements, and closing it pulls later elements left', () => {
  const doc = docWith(clipAt(1, 2), clipAt(5, 2));
  const track = doc.tracks[0].id;
  assert.deepEqual(gapAt(doc, track, 0.5), { trackId: track, start: 0, end: 1 }, 'a title-page gap at the very start counts');
  assert.deepEqual(gapAt(doc, track, 4), { trackId: track, start: 3, end: 5 });
  assert.equal(gapAt(doc, track, 2), null, 'inside an element');
  assert.equal(gapAt(doc, track, 9), null, 'after the last element nothing needs closing');
  const closed = closeGap(doc, gapAt(doc, track, 4)!);
  assert.deepEqual(closed.items.map((i) => i.start), [1, 3]);
});

test('closing a gap leaves other tracks alone', () => {
  const doc = docWith(clipAt(0, 1), clipAt(4, 1));
  const made = insertTrack(doc, 0);
  const above = { ...makeAudioItem(asset({ kind: 'audio' }), made.trackId, 6) };
  const withAudio = { ...made.doc, items: [...made.doc.items, above] };
  const closed = closeGap(withAudio, gapAt(withAudio, doc.tracks[0].id, 2)!);
  assert.equal(closed.items.find((i) => i.id === above.id)!.start, 6);
});

test('overlap checks treat touching elements as free', () => {
  const doc = docWith(clipAt(2, 2));
  const track = doc.tracks[0].id;
  assert.ok(rangeFree(doc, track, 0, 2));
  assert.ok(rangeFree(doc, track, 4, 6));
  assert.ok(!rangeFree(doc, track, 3.9, 6));
});

test('a dropped clip lands in the nearest gap it fits', () => {
  const doc = docWith(clipAt(0, 2), clipAt(3, 2), clipAt(10, 2));
  const track = doc.tracks[0].id;
  assert.equal(nearestFreeStart(doc, track, 1, 1), 2, 'slides into the one-second gap');
  assert.equal(nearestFreeStart(doc, track, 1, 2), 5, 'too long for that gap, so the next one');
  assert.equal(nearestFreeStart(doc, track, 7, 2), 7, 'free where asked');
  assert.equal(nearestFreeStart(doc, track, 20, 2), 20);
});

test('snapping picks the closest edge within reach', () => {
  const doc = docWith(clipAt(2, 2));
  const points = snapPoints(doc, new Set(), [9]);
  assert.deepEqual(points.sort((a, b) => a - b), [0, 2, 4, 9]);
  assert.deepEqual(snapValue(4.05, points, 0.1), { value: 4, hit: 4 });
  assert.deepEqual(snapValue(4.5, points, 0.1), { value: 4.5, hit: null });
  assert.deepEqual(snapClip(4.04, 3, points, 0.1), { start: 4, hit: 4 }, 'by its start edge');
  assert.deepEqual(snapClip(5.97, 3, points, 0.1), { start: 6, hit: 9 }, 'by its end edge');
});

test('a group is selected and released as a whole', () => {
  const doc = docWith(clipAt(0, 1), clipAt(2, 1), clipAt(4, 1));
  const [a, b, c] = doc.items.map((i) => i.id);
  const grouped = groupItems(doc, [a, b]);
  assert.deepEqual(withGroupMembers(grouped, [a]).sort(), [a, b].sort());
  assert.deepEqual(withGroupMembers(grouped, [c]), [c]);
  assert.deepEqual(withGroupMembers(ungroupItems(grouped, [a]), [a]), [a], 'ungrouping one member releases all');
});

test('copies get new ids and their own group', () => {
  const doc = groupItems(docWith(clipAt(0, 1), clipAt(2, 1)), []);
  const grouped = groupItems(doc, doc.items.map((i) => i.id));
  const copies = cloneItems(grouped.items, 5);
  assert.deepEqual(copies.map((c) => c.start), [5, 7]);
  assert.notEqual(copies[0].id, grouped.items[0].id);
  assert.equal(copies[0].groupId, copies[1].groupId);
  assert.notEqual(copies[0].groupId, grouped.items[0].groupId);
});

test('pasting keeps relative timing and never overlaps', () => {
  const doc = docWith(clipAt(0, 2));
  const pasted = pasteItems(doc, doc.items, 1);
  assert.equal(pasted.ids.length, 1);
  assert.equal(pasted.doc.tracks.length, 2, 'the track was taken at that time, so a new layer appears');
  const copy = pasted.doc.items.find((i) => i.id === pasted.ids[0])!;
  assert.equal(copy.start, 1);
  assert.equal(copy.trackId, pasted.doc.tracks[0].id, 'above the original');
  const after = pasteItems(doc, doc.items, 3);
  assert.equal(after.doc.tracks.length, 1, 'free space on the same track is used');
});

test('pasting several layers keeps them in the same stacking order', () => {
  const doc = newProjectDoc('p', 'Test');
  const top = insertTrack(doc, 0);
  const base = top.doc.tracks[1].id;
  const under = { ...makeVideoItem(asset(), top.doc, base, 0), duration: 2 };
  const over = makeTextItem(top.doc, top.trackId, 0, 'x', {}, { duration: 2 });
  const full: ProjectDoc = { ...top.doc, items: [under, over] };
  const result = pasteItems(full, full.items, 4);
  const [pu, po] = [result.doc.items.find((i) => i.type === 'video' && i.id !== under.id)!, result.doc.items.find((i) => i.type === 'text' && i.id !== over.id)!];
  const row = (id: string): number => result.doc.tracks.findIndex((t) => t.id === id);
  assert.ok(row(po.trackId) < row(pu.trackId), 'the text stays above the video');
});

test('removing the last element of a track removes the track, but one track always remains', () => {
  const doc = docWith(clipAt(0, 1));
  const made = insertTrack(doc, 0);
  const two = { ...made.doc, items: [...made.doc.items, makeAudioItem(asset({ kind: 'audio' }), made.trackId, 0)] };
  const one = removeItems(two, [two.items[1].id]);
  assert.equal(one.tracks.length, 1);
  const none = removeItems(one, [one.items[0].id]);
  assert.equal(none.tracks.length, 1);
  assert.equal(pruneEmptyTracks(none), none);
});

test('media is fitted to the frame without distortion', () => {
  assert.deepEqual(fitBox(1000, 1000, 1920, 1080), { x: 420, y: 0, w: 1080, h: 1080 });
  assert.deepEqual(fitBox(1000, 1000, 1920, 1080, 'cover'), { x: 0, y: -420, w: 1920, h: 1920 });
});

test('the canvas takes the size of the footage, kept even and within 4K', () => {
  assert.deepEqual(canvasForMedia(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(canvasForMedia(1281, 721), { width: 1282, height: 722 });
  assert.deepEqual(canvasForMedia(7680, 4320), { width: 3840, height: 2160 });
});

test('changing the canvas keeps full-frame footage full-frame', () => {
  const doc = docWith(clipAt(0, 2));
  const portrait = resizeCanvas(doc, 1080, 1920, 'fill');
  const v = portrait.items[0] as VideoItem;
  assert.equal(v.h, 1920);
  assert.ok(Math.abs(v.w / v.h - 16 / 9) < 1e-6, 'without distortion');
  assert.equal(v.x + v.w / 2, 540, 'and centred');
  assert.equal(portrait.settings.autoSize, false);
});

test('changing the canvas scales text and keeps its place', () => {
  const doc = newProjectDoc('p', 'Test');
  const text = makeTextItem(doc, doc.tracks[0].id, 0, 'x');
  doc.items = [{ ...text, x: 100, y: 100 }];
  const small = resizeCanvas(doc, 960, 540, 'fit');
  const t = small.items[0];
  assert.ok(t.type === 'text');
  if (t.type === 'text') {
    assert.equal(t.style.fontSize, text.style.fontSize / 2);
    assert.equal(t.w, text.w / 2);
  }
});

test('quantizing lines every element up with the frame grid', () => {
  const doc = docWith(clipAt(1.012, 2.003));
  const q = quantize(doc);
  assert.equal(q.items[0].start * 30, Math.round(q.items[0].start * 30));
  assert.ok(Math.abs(itemEnd(q.items[0]) * 30 - Math.round(itemEnd(q.items[0]) * 30)) < 1e-9);
  assert.equal(quantize(q).items[0], q.items[0], 'stable once aligned');
});
