// End-to-end checks of the export pipeline against the real ffmpeg build:
// the plan produced by shared/render.ts is executed and the resulting MP4 is inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutputSpec } from '../../src/shared/render.ts';
import { resolveOutputSpec } from '../../src/shared/render.ts';
import type { Asset, ProjectDoc } from '../../src/shared/types.ts';
import { insertTrack, makeAudioItem, makeImageItem, makeTextItem, makeVideoItem, newProjectDoc, splitAt } from '../../src/shared/timeline.ts';
import { assetFor, audioLevel, describe, frameAt, near, render } from './helpers.mts';

function project(width: number, height: number, fps = 30): ProjectDoc {
  const doc = newProjectDoc('p1', 'Test');
  doc.settings = { ...doc.settings, width, height, fps, autoSize: false, background: '#204080' };
  return doc;
}

function specFor(doc: ProjectDoc, assets: Asset[], presetId = 'standard'): OutputSpec {
  doc.settings.exportPresetId = presetId;
  return resolveOutputSpec(doc, Object.fromEntries(assets.map((a) => [a.id, a])));
}

/** Adds a track above everything and returns its id. */
function trackOnTop(doc: ProjectDoc): string {
  const made = insertTrack(doc, 0);
  doc.tracks = made.doc.tracks;
  return made.trackId;
}

test('composites video, image, text overlay and audio into a bt709 H.264/AAC MP4', async () => {
  const [clip, logo, tone] = await Promise.all([assetFor('clip-b.mp4'), assetFor('logo.png'), assetFor('tone.mp3')]);
  const doc = project(1280, 720);
  const base = doc.tracks[0].id;

  // Bottom: a 4 s video scaled to the left half. Above it a logo for 1–3 s, then a text box for 2–4 s.
  const video = makeVideoItem(clip, doc, base, 0);
  Object.assign(video, { x: 0, y: 180, w: 640, h: 360 });
  const image = makeImageItem(logo, doc, trackOnTop(doc), 1, 2);
  Object.assign(image, { x: 900, y: 100, w: 200, h: 200 });
  const text = makeTextItem(doc, trackOnTop(doc), 2, 'Hello', {}, { duration: 2 });
  Object.assign(text, { x: 700, y: 500, w: 400, h: 100 });
  const audioTrack = insertTrack(doc, doc.tracks.length);
  doc.tracks = audioTrack.doc.tracks;
  const audio = makeAudioItem(tone, audioTrack.trackId, 1);
  audio.duration = 2;
  video.muted = true;
  doc.items = [video, image, text, audio];

  const spec = specFor(doc, [clip, logo, tone]);
  assert.equal(spec.width, 1280);
  assert.equal(spec.height, 720);
  assert.equal(spec.fps, 25, 'footage slower than the project setting sets the export rate');

  const out = await render(doc, [clip, logo, tone], spec, { label: 'basic' });
  const info = await describe(out.file);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.pixFmt, 'yuv420p');
  assert.equal(info.video.width, 1280);
  assert.equal(info.video.height, 720);
  assert.equal(info.video.fps, 25);
  assert.equal(info.video.frames, 100);
  assert.equal(info.video.colorSpace, 'bt709');
  assert.equal(info.video.colorTransfer, 'bt709');
  assert.equal(info.video.colorRange, 'tv');
  assert.ok(Math.abs(info.duration - 4) < 0.08, `duration ${info.duration}`);
  assert.deepEqual(info.audio, { codec: 'aac', sampleRate: 48000, channels: 2 });
  assert.ok(out.progress.at(-1) === 1 && out.progress.every((p, i) => i === 0 || p >= out.progress[i - 1] - 1e-9), 'progress is monotonic');

  const bg: [number, number, number] = [0x20, 0x40, 0x80];
  const logoRed: [number, number, number] = [235, 64, 80];
  const white: [number, number, number] = [255, 255, 255];

  // t = 0.5: only the video is visible.
  let px = await frameAt(out.file, 0.5, 1280, 720);
  assert.ok(near(px(1000, 60), bg), `background ${px(1000, 60)}`);
  assert.ok(near(px(1000, 200), bg), `logo must not be visible yet ${px(1000, 200)}`);
  assert.ok(!near(px(320, 360), bg), 'video covers the left half');

  // t = 1.5: logo visible (its circle is opaque red, its corners are transparent).
  px = await frameAt(out.file, 1.5, 1280, 720);
  assert.ok(near(px(1000, 200), logoRed), `logo centre ${px(1000, 200)}`);
  assert.ok(near(px(905, 105), bg), `logo corner is transparent ${px(905, 105)}`);
  assert.ok(near(px(900, 550), bg), `text must not be visible yet ${px(900, 550)}`);

  // t = 2.5: logo and text.
  px = await frameAt(out.file, 2.5, 1280, 720);
  assert.ok(near(px(1000, 200), logoRed));
  assert.ok(near(px(900, 550), white), `text box ${px(900, 550)}`);

  // t = 3.5: logo gone, text still there.
  px = await frameAt(out.file, 3.5, 1280, 720);
  assert.ok(near(px(1000, 200), bg), `logo must be gone ${px(1000, 200)}`);
  assert.ok(near(px(900, 550), white));

  // Audio: silent, then the tone for 1–3 s, then silent again (the video's own audio is muted).
  assert.ok((await audioLevel(out.file, 0.1, 0.8)) < 0.01, 'silence before the tone');
  const tone1 = await audioLevel(out.file, 1.3, 2.7);
  assert.ok(tone1 > 0.07 && tone1 < 0.09, `mono tone plays at full level in both channels, got ${tone1}`);
  assert.ok((await audioLevel(out.file, 3.3, 3.9)) < 0.01, 'silence after the tone');
});

test('text and image layers switch on the exact frame', async () => {
  const [clip] = await Promise.all([assetFor('silent.mp4')]);
  const doc = project(640, 360, 24);
  const video = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
  const text = makeTextItem(doc, trackOnTop(doc), 1, 'x', {}, { duration: 1 });
  Object.assign(text, { x: 100, y: 100, w: 200, h: 100 });
  doc.items = [video, text];
  const spec = specFor(doc, [clip]);
  const out = await render(doc, [clip], spec, { label: 'frames' });

  const white: [number, number, number] = [255, 255, 255];
  // Seeking returns the first frame at or after the requested time, so aim just before the frame.
  const at = async (frame: number): Promise<boolean> =>
    near((await frameAt(out.file, Math.max(0, (frame - 0.25) / 24), spec.width, spec.height))(200 * (spec.width / 640), 150 * (spec.height / 360)), white);
  assert.equal(await at(23), false, 'frame before the text starts');
  assert.equal(await at(24), true, 'first frame of the text');
  assert.equal(await at(47), true, 'last frame of the text');
  assert.equal(await at(48), false, 'frame after the text ends');
});

test('long edits are rendered in chunks that join seamlessly', async () => {
  const clip = await assetFor('clip-a.mp4');
  let doc = project(1280, 720);
  doc.items = [makeVideoItem(clip, doc, doc.tracks[0].id, 0)];
  // Cut the 6 s clip into 12 half-second pieces.
  for (let t = 0.5; t < 6; t += 0.5) doc = splitAt(doc, doc.items.map((it) => it.id), t).doc;
  assert.equal(doc.items.length, 12);

  const spec = specFor(doc, [clip]);
  const chunked = await render(doc, [clip], spec, { maxInputs: 2, label: 'chunked' });
  assert.ok(chunked.chunkCount >= 6, `expected several chunks, got ${chunked.chunkCount}`);
  const info = await describe(chunked.file);
  assert.equal(info.video.frames, 180);
  assert.ok(Math.abs(info.duration - 6) < 0.08);

  // The same project rendered in one piece must look the same frame for frame.
  const whole = await render(doc, [clip], spec, { maxInputs: 100, label: 'whole' });
  assert.equal(whole.chunkCount, 1);
  for (const t of [0.26, 0.51, 1.49, 2.99, 3.01, 5.9]) {
    const a = await frameAt(chunked.file, t, 1280, 720);
    const b = await frameAt(whole.file, t, 1280, 720);
    for (const [x, y] of [[100, 100], [640, 360], [1100, 600], [333, 444]]) {
      assert.ok(near(a(x, y), b(x, y), 10), `t=${t} (${x},${y}): ${a(x, y)} vs ${b(x, y)}`);
    }
  }
});

test('a section of the timeline can be rendered on its own', async () => {
  const [clip, tone] = await Promise.all([assetFor('clip-a.mp4'), assetFor('tone.mp3')]);
  const doc = project(1280, 720);
  const video = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
  video.muted = true;
  const a = insertTrack(doc, 1);
  doc.tracks = a.doc.tracks;
  const audio = makeAudioItem(tone, a.trackId, 3);
  audio.duration = 3;
  doc.items = [video, audio];
  const spec = specFor(doc, [clip, tone]);

  const out = await render(doc, [clip, tone], spec, { window: { start: 2, end: 4 }, label: 'section' });
  const info = await describe(out.file);
  assert.equal(info.video.frames, 60);
  assert.ok(Math.abs(info.duration - 2) < 0.08);
  // The tone starts at 3 s on the timeline, i.e. 1 s into the section.
  assert.ok((await audioLevel(out.file, 0.1, 0.8)) < 0.01);
  assert.ok((await audioLevel(out.file, 1.2, 1.9)) > 0.05);

  // The picture at section time t equals the full render at 2 + t.
  const full = await render(doc, [clip, tone], spec, { label: 'section-full' });
  const p = await frameAt(out.file, 0.5, 1280, 720);
  const q = await frameAt(full.file, 2.5, 1280, 720);
  for (const [x, y] of [[100, 100], [640, 360], [1100, 600]]) assert.ok(near(p(x, y), q(x, y), 10), `${p(x, y)} vs ${q(x, y)}`);
});

test('speed, volume, opacity and fades are applied', async () => {
  const [clip, tone] = await Promise.all([assetFor('clip-a.mp4'), assetFor('tone.wav')]);
  const doc = project(1280, 720);
  doc.settings.background = '#ffffff';
  const video = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
  video.speed = 2;
  video.duration = 3; // 6 s of footage played at 2x
  video.opacity = 0.5;
  video.muted = true;
  const a = insertTrack(doc, 1);
  doc.tracks = a.doc.tracks;
  const audio = makeAudioItem(tone, a.trackId, 0);
  audio.duration = 3;
  audio.volume = 0.25;
  audio.fadeAudio = true;
  doc.items = [video, audio];
  const spec = specFor(doc, [clip, tone]);
  const out = await render(doc, [clip, tone], spec, { label: 'effects' });
  const info = await describe(out.file);
  assert.equal(info.video.frames, 90);

  // Half-transparent video over white is the average of the opaque render and white.
  video.opacity = 1;
  const opaque = await render(doc, [clip, tone], spec, { label: 'effects-opaque' });
  const half = await frameAt(out.file, 1.5, 1280, 720);
  const full = await frameAt(opaque.file, 1.5, 1280, 720);
  for (const [x, y] of [[100, 100], [640, 360], [1100, 600], [200, 650]]) {
    const expected = full(x, y).map((c) => (c + 255) / 2) as [number, number, number];
    assert.ok(near(half(x, y), expected, 24), `pixel ${half(x, y)} should be about ${expected}`);
  }
  // 2x speed: the frame at 1.5 s of the export is the frame at 3 s of the footage.
  const sourceDoc = project(1280, 720);
  sourceDoc.settings.background = '#ffffff';
  const plain = makeVideoItem(clip, sourceDoc, sourceDoc.tracks[0].id, 0);
  sourceDoc.items = [plain];
  const normal = await render(sourceDoc, [clip], spec, { label: 'effects-1x' });
  const at3 = await frameAt(normal.file, 3.0, 1280, 720);
  for (const [x, y] of [[100, 100], [640, 360], [1100, 600], [200, 650]]) {
    assert.ok(near(full(x, y), at3(x, y), 24), `2x speed frame ${full(x, y)} vs source ${at3(x, y)}`);
  }
  const mid = await audioLevel(out.file, 1.2, 1.8);
  const head = await audioLevel(out.file, 0, 0.12);
  // The fixture is a sine at 1/8 amplitude (mean level 0.0796); a quarter of that is about 0.02.
  assert.ok(mid > 0.015 && mid < 0.025, `quarter volume, got ${mid}`);
  assert.ok(head < mid * 0.5, `fade-in should start quiet (${head} vs ${mid})`);
});

test('every supported input format can be exported', async () => {
  const videos = ['clip-a.mp4', 'phone.m4v', 'prores.mov', 'matroska.mkv', 'vp9.webm', 'old.avi', 'theora.ogv', 'flash.flv', 'stream.ts', 'anim.gif', 'hevc.mp4', 'hdr.mp4', 'alpha.webm'];
  const audios = ['tone.mp3', 'tone.m4a', 'tone.ogg', 'tone.oga', 'tone.wav', 'tone.aac', 'tone.flac'];
  const images = ['photo.jpg', 'wide.jpeg', 'logo.png', 'pic.webp', 'pic.avif'];
  const assets = await Promise.all([...videos, ...audios, ...images].map(assetFor));
  const byName = Object.fromEntries(assets.map((a) => [a.name, a]));

  assert.equal(byName['hdr.mp4'].isHdr, true);
  assert.equal(byName['alpha.webm'].hasAlpha, true);
  assert.equal(byName['logo.png'].hasAlpha, true);
  assert.equal(byName['anim.gif'].kind, 'video');
  assert.equal(byName['pic.avif'].kind, 'image');

  const doc = project(1280, 720);
  const vTrack = doc.tracks[0].id;
  const iTrack = trackOnTop(doc);
  const aTrackMade = insertTrack(doc, doc.tracks.length);
  doc.tracks = aTrackMade.doc.tracks;
  let t = 0;
  for (const name of videos) {
    const it = makeVideoItem(byName[name], doc, vTrack, t);
    it.duration = Math.min(1, it.duration);
    doc.items.push(it);
    t += it.duration;
  }
  let ti = 0;
  for (const name of images) {
    const it = makeImageItem(byName[name], doc, iTrack, ti, 1);
    Object.assign(it, { x: 900, y: 40, w: 320, h: 240 });
    doc.items.push(it);
    ti += 1;
  }
  let ta = 0;
  for (const name of audios) {
    const it = makeAudioItem(byName[name], aTrackMade.trackId, ta);
    it.duration = 1;
    doc.items.push(it);
    ta += 1;
  }
  const spec = specFor(doc, assets);
  const out = await render(doc, assets, spec, { label: 'formats' });
  const info = await describe(out.file);
  assert.ok(Math.abs(info.duration - t) < 0.1, `duration ${info.duration} vs ${t}`);
  assert.equal(info.video.frames, Math.round(t * spec.fps));

  // Each video second shows picture, not the background colour.
  const bg: [number, number, number] = [0x20, 0x40, 0x80];
  for (let i = 0; i < videos.length; i++) {
    if (videos[i] === 'alpha.webm') continue; // transparent outside its circle by design
    const px = await frameAt(out.file, i + 0.5, 1280, 720);
    const samples: [number, number][] = [[200, 200], [400, 500], [640, 360], [700, 600]];
    assert.ok(samples.some(([x, y]) => !near(px(x, y), bg, 8)), `${videos[i]} produced no picture`);
  }
  // The transparent WebM keeps its alpha: yellow disc in the middle, background in the corner.
  const ia = videos.indexOf('alpha.webm');
  const pa = await frameAt(out.file, ia + 0.5, 1280, 720);
  assert.ok(near(pa(640, 360), [255, 200, 0], 30), `alpha clip centre ${pa(640, 360)}`);
  assert.ok(near(pa(300, 20), bg), `alpha clip corner ${pa(300, 20)}`);
});

test('trimmed clips start on the right frame even in formats that cannot seek', async () => {
  // stream.ts has a single keyframe and anim.gif has no index: seeking into either would miss.
  for (const name of ['stream.ts', 'anim.gif', 'clip-a.mp4']) {
    const clip = await assetFor(name);
    const doc = project(1280, 720);
    const full = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
    full.muted = true;
    doc.items = [full];
    const spec = specFor(doc, [clip]);
    const whole = await render(doc, [clip], spec, { label: 'trim-whole' });

    const trimmed = { ...full, trimStart: 1, duration: full.duration - 1 };
    doc.items = [trimmed];
    const cut = await render(doc, [clip], spec, { label: 'trim-cut' });
    assert.equal((await describe(cut.file)).video.frames, Math.round((full.duration - 1) * spec.fps), name);

    // Half a second into the trimmed clip is 1.5 s into the footage.
    const a = await frameAt(cut.file, 0.5, 1280, 720);
    const b = await frameAt(whole.file, 1.5, 1280, 720);
    let same = 0;
    const points: [number, number][] = [[100, 100], [640, 360], [1100, 600], [333, 444], [900, 200], [250, 620]];
    for (const [x, y] of points) if (near(a(x, y), b(x, y), 14)) same++;
    assert.ok(same >= points.length - 1, `${name}: trimmed frame does not match the source (${same}/${points.length})`);
  }
});

test('video with rotation metadata keeps its orientation', async () => {
  const clip = await assetFor('rotated.mp4');
  assert.deepEqual([clip.width, clip.height], [720, 1280], 'width and height are swapped for a quarter turn');
  const doc = project(720, 1280);
  const item = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
  item.muted = true;
  doc.items = [item];
  doc.settings.exportPresetId = 'standard';
  const spec = resolveOutputSpec(doc, { [clip.id]: clip });
  assert.deepEqual([spec.width, spec.height], [720, 1280]);
  const out = await render(doc, [clip], spec, { label: 'rotated' });
  const info = await describe(out.file);
  assert.deepEqual([info.video.width, info.video.height], [720, 1280]);
  // The footage has vertical colour bars, so turned upright they become horizontal: the colour
  // changes going down the frame and stays the same going across.
  const px = await frameAt(out.file, 0.1, 720, 1280);
  const across = [px(120, 640), px(360, 640), px(600, 640)];
  const down = [px(360, 100), px(360, 640), px(360, 1180)];
  assert.ok(near(across[0], across[1], 30) && near(across[1], across[2], 30), `same colour across: ${across.join(' | ')}`);
  assert.ok(!near(down[0], down[1], 30) && !near(down[1], down[2], 30), `different colours going down: ${down.join(' | ')}`);
});

test('audio trims are sample-accurate for raw AAC', async () => {
  const tone = await assetFor('tone.aac');
  const doc = project(1280, 720);
  const item = makeAudioItem(tone, doc.tracks[0].id, 1);
  item.trimStart = 2;
  item.duration = 1;
  doc.items = [item];
  doc.settings.durationMode = 'fixed';
  doc.settings.fixedDuration = 3;
  const spec = specFor(doc, [tone]);
  const out = await render(doc, [tone], spec, { window: { start: 0, end: 3 }, label: 'aac' });
  assert.ok((await audioLevel(out.file, 0.1, 0.9)) < 0.01, 'silent before the clip');
  assert.ok((await audioLevel(out.file, 1.1, 1.9)) > 0.05, 'tone during the clip');
  assert.ok((await audioLevel(out.file, 2.1, 2.9)) < 0.01, 'silent after the clip');
});

test('constant-bitrate presets hit their target and 4K scales the canvas', async () => {
  const clip = await assetFor('clip-a.mp4');
  const doc = project(1280, 720);
  const video = makeVideoItem(clip, doc, doc.tracks[0].id, 0);
  doc.items = [video];

  const cbr = specFor(doc, [clip], 'yt-720');
  assert.equal(cbr.rateControl, 'cbr');
  assert.equal(cbr.bitrateKbps, 5000);
  const out = await render(doc, [clip], cbr, { label: 'cbr' });
  const { statSync } = await import('node:fs');
  const kbps = (statSync(out.file).size * 8) / 6 / 1000;
  assert.ok(kbps > 3500 && kbps < 6500, `expected about 5300 kbit/s in total, got ${kbps.toFixed(0)}`);

  const uhd = specFor(doc, [clip], '4k');
  assert.equal(uhd.width, 3840);
  assert.equal(uhd.height, 2160);
  assert.equal(uhd.rateControl, 'vbr');
});
