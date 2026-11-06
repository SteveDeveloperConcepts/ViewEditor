import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancedFromPreset, getPreset } from '../../src/shared/constants.ts';
import {
  buildRenderCommands,
  effectiveFps,
  exportSize,
  fpsArg,
  listOverlayFiles,
  planChunks,
  planLayers,
  resolveOutputSpec,
  sourceResolution,
  windowItem,
  type RenderSource,
} from '../../src/shared/render.ts';
import { insertTrack, makeTextItem, makeVideoItem, newProjectDoc } from '../../src/shared/timeline.ts';
import type { Asset, ProjectDoc } from '../../src/shared/types.ts';

function asset(patch: Partial<Asset> = {}): Asset {
  return {
    id: 'a1', kind: 'video', name: 'a.mp4', ext: 'mp4', size: 1, createdAt: 0, source: 'upload', scope: 'project', projectId: null,
    duration: 20, width: 1920, height: 1080, fps: 30, hasAudio: false, audioChannels: 0, hasAlpha: false, isHdr: false,
    videoCodec: 'h264', audioCodec: null, colorMatrix: 'bt709', hasThumb: false, strip: null, hasWave: false,
    proxy: 'none', proxyExt: null, previewChecked: true, raster: 'none', ...patch,
  };
}

function withClip(patch: Partial<Asset> = {}, duration = 10): { doc: ProjectDoc; a: Asset } {
  const a = asset(patch);
  const doc = newProjectDoc('p', 'Test');
  doc.items = [{ ...makeVideoItem(a, doc, doc.tracks[0].id, 0), duration }];
  return { doc, a };
}

test('a hidden row leaves the picture but keeps its sound, and a muted row the other way round', () => {
  const { doc } = withClip({ hasAudio: true, audioChannels: 2 });
  const window = { start: 0, end: 10 };
  const hidden = { ...doc, tracks: [{ ...doc.tracks[0], hidden: true }] };
  assert.equal(planLayers(hidden, window).ops.length, 0);
  assert.equal(planLayers(doc, window).ops.length, 1);
  const spec = resolveOutputSpec(doc, {});
  const source: RenderSource = { path: 'a.mp4', kind: 'video', hasAudio: true, audioChannels: 2, hasAlpha: false, isHdr: false, colorMatrix: 'bt709', videoCodec: 'h264', seekable: true };
  const build = (d: ProjectDoc) => buildRenderCommands({ doc: d, window, spec, sources: { a1: source }, workDir: 'w', outputPath: 'o.mp4', caps: { tonemap: false } });
  assert.ok(build(hidden).audio.args.includes('a.mp4'), 'the sound of a hidden row still plays');
  const muted = { ...doc, tracks: [{ ...doc.tracks[0], muted: true }] };
  assert.ok(!build(muted).audio.args.includes('a.mp4'));
  assert.ok(build(muted).chunks[0].args.includes('a.mp4'), 'the picture of a muted row still shows');
});

test('export size follows the short side, for any shape', () => {
  assert.deepEqual(exportSize(1920, 1080, 720), { width: 1280, height: 720 });
  assert.deepEqual(exportSize(1080, 1920, 720), { width: 720, height: 1280 });
  assert.deepEqual(exportSize(1080, 1080, 2160), { width: 2160, height: 2160 });
  assert.deepEqual(exportSize(1081, 721, 720), { width: 1080, height: 720 }, 'dimensions stay even');
});

test('footage slower than the project sets the frame rate; nothing goes above 60', () => {
  const slow = withClip({ fps: 24 });
  assert.equal(effectiveFps(slow.doc, { a1: slow.a }), 24);
  const fast = withClip({ fps: 120 });
  fast.doc.settings.fps = 60;
  assert.equal(effectiveFps(fast.doc, { a1: fast.a }), 60);
  const same = withClip({ fps: 60 });
  assert.equal(effectiveFps(same.doc, { a1: same.a }), 30, 'the project setting is the ceiling');
  const none = newProjectDoc('p', 'Test');
  assert.equal(effectiveFps(none, {}), 30, 'with no footage the project setting applies');
});

test('NTSC frame rates are exact fractions', () => {
  assert.equal(fpsArg(29.97), '30000/1001');
  assert.equal(fpsArg(23.976), '24000/1001');
  assert.equal(fpsArg(25), '25');
});

test('most presets use variable bitrate; the YouTube ones use constant', () => {
  assert.equal(getPreset('hd').rateControl, 'vbr');
  assert.equal(getPreset('yt-1080').rateControl, 'cbr');
  assert.equal(advancedFromPreset('yt-1080', 30).bitrateKbps, 8000);
  assert.equal(advancedFromPreset('yt-1080', 60).bitrateKbps, 12000, 'higher frame rates get more bits');
});

test('advanced settings override the preset', () => {
  const { doc, a } = withClip();
  doc.settings.exportPresetId = 'draft';
  doc.settings.exportAdvanced = { resolution: 1440, rateControl: 'cbr', crf: 20, bitrateKbps: 9000, speed: 'compact' };
  const spec = resolveOutputSpec(doc, { a1: a });
  assert.deepEqual([spec.width, spec.height, spec.rateControl, spec.bitrateKbps, spec.x264Preset], [2560, 1440, 'cbr', 9000, 'slow']);
});

test('sourceResolution reports the best footage in the project', () => {
  const { doc, a } = withClip({ width: 1280, height: 720 });
  assert.equal(sourceResolution(doc, { a1: a }), 720);
});

test('a window re-bases elements and moves their in-point', () => {
  const { doc } = withClip();
  const part = windowItem(doc.items[0], { start: 2, end: 5 });
  assert.ok(part && part.type === 'video');
  if (part?.type === 'video') assert.deepEqual([part.start, part.duration, part.trimStart], [0, 3, 2]);
  assert.equal(windowItem(doc.items[0], { start: 11, end: 12 }), null);
});

test('layers are composited bottom first, with neighbouring text sharing one overlay', () => {
  const { doc } = withClip();
  const t1 = insertTrack(doc, 0);
  const t2 = insertTrack(t1.doc, 0);
  const a = makeTextItem(t2.doc, t1.trackId, 0, 'lower', {}, { duration: 4 });
  const b = makeTextItem(t2.doc, t2.trackId, 2, 'upper', {}, { duration: 4 });
  const full: ProjectDoc = { ...t2.doc, items: [...t2.doc.items, a, b] };
  const plan = planLayers(full, { start: 0, end: 10 });
  assert.deepEqual(plan.ops.map((o) => o.kind), ['media', 'overlay']);
  const run = plan.runs[0];
  assert.deepEqual(run.segments.map((s) => [s.start, s.end, s.itemIds.length]), [[0, 2, 1], [2, 4, 2], [4, 6, 1], [6, 10, 0]]);
  assert.deepEqual(run.segments[1].itemIds, [a.id, b.id], 'the lower text draws first');
  assert.equal(listOverlayFiles(plan).length, 3, 'stretches with no text need no picture');
});

test('text on either side of footage stays in the right place in the stack', () => {
  const { doc } = withClip();
  const base = doc.tracks[0].id;
  const below = insertTrack(doc, 1);
  const text = makeTextItem(below.doc, below.trackId, 0, 'behind the video', {}, { duration: 3 });
  const plan = planLayers({ ...below.doc, items: [...below.doc.items, text] }, { start: 0, end: 10 });
  assert.deepEqual(plan.ops.map((o) => o.kind), ['overlay', 'media']);
  assert.ok(base);
});

test('empty text is left out of the render', () => {
  const { doc } = withClip();
  const t = insertTrack(doc, 0);
  const blank = makeTextItem(t.doc, t.trackId, 0, '   ', {}, { duration: 2 });
  assert.equal(planLayers({ ...t.doc, items: [...t.doc.items, blank] }, { start: 0, end: 10 }).runs.length, 0);
});

test('chunks cut at clip boundaries and respect the input limit', () => {
  const { doc } = withClip({}, 1);
  const a = asset();
  doc.items = Array.from({ length: 30 }, (_, i) => ({ ...makeVideoItem(a, doc, doc.tracks[0].id, i), duration: 1 }));
  const plan = planLayers(doc, { start: 0, end: 30 });
  const chunks = planChunks(plan, 30, 4);
  assert.ok(chunks.length >= 7, String(chunks.length));
  assert.equal(chunks[0].startFrame, 0);
  assert.equal(chunks.at(-1)!.endFrame, 900);
  chunks.forEach((c, i) => {
    if (i) assert.equal(c.startFrame, chunks[i - 1].endFrame, 'chunks are contiguous');
    assert.equal(c.startFrame % 30, 0, 'cuts land on clip boundaries');
  });
  assert.equal(planChunks(plan, 30, 100).length, 1);
});

test('a single long clip is one chunk even with a tight limit', () => {
  const { doc } = withClip({}, 10);
  assert.equal(planChunks(planLayers(doc, { start: 0, end: 10 }), 30, 1).length, 1);
});

test('commands name the required output format', () => {
  const { doc, a } = withClip({ hasAudio: true, audioChannels: 2, audioCodec: 'aac' });
  const spec = resolveOutputSpec(doc, { a1: a });
  const source: RenderSource = {
    path: 'clip.mp4', kind: 'video', hasAudio: true, audioChannels: 2, hasAlpha: false, isHdr: false, colorMatrix: 'bt709', videoCodec: 'h264', seekable: true,
  };
  const cmds = buildRenderCommands({
    doc, window: { start: 0, end: 10 }, spec, sources: { a1: source }, workDir: 'C:\\work\\dir', outputPath: 'out.mp4', caps: { tonemap: true },
  });
  const video = cmds.chunks[0].args.join(' ');
  for (const part of ['-c:v libx264', '-pix_fmt yuv420p', '-colorspace bt709', '-color_primaries bt709', '-color_trc bt709', '-crf 20']) assert.ok(video.includes(part), part);
  const mux = cmds.mux.args.join(' ');
  for (const part of ['-c:v copy', '-c:a aac', '-b:a 320k', '-movflags +faststart']) assert.ok(mux.includes(part), part);
  assert.ok(!cmds.textFiles.some((f) => f.path.includes('\\')), 'paths in concat lists use forward slashes');
  assert.equal(cmds.totalFrames, 300);
});

test('HDR sources are tone-mapped when the ffmpeg build can do it', () => {
  const { doc, a } = withClip({ isHdr: true });
  const spec = resolveOutputSpec(doc, { a1: a });
  const source: RenderSource = {
    path: 'hdr.mp4', kind: 'video', hasAudio: false, audioChannels: 0, hasAlpha: false, isHdr: true, colorMatrix: 'bt2020', videoCodec: 'hevc', seekable: true,
  };
  const build = (tonemap: boolean): string =>
    buildRenderCommands({ doc, window: { start: 0, end: 10 }, spec, sources: { a1: source }, workDir: 'w', outputPath: 'o.mp4', caps: { tonemap } }).chunks[0].args.join(' ');
  assert.ok(build(true).includes('tonemap=tonemap=hable'));
  assert.ok(!build(false).includes('tonemap'));
});
