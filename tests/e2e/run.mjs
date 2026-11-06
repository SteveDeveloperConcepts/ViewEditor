// Drives the built app the way a person would, following the getting-started documentation
// feature by feature, and checks real results: DOM state, files on disk, and pixels of exported video.
//
// Usage: npm run build && node tests/e2e/run.mjs [section ...]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FakeProviders, KEYS } from '../support/fakeProviders.mts';
import { MOD, check, cleanup, clips, launch, media, newDataDir, shot, stubOpenDialog, stubSaveDialog, summary } from './lib.mjs';

const require = createRequire(import.meta.url);
const { ffmpegPath, ffprobePath } = require('ffmpeg-ffprobe-static');

const only = process.argv.slice(2);
const dir = newDataDir();
let { app, page, errors } = await launch(dir);
const allErrors = [];

// ---------------------------------------------------------------- helpers

const probe = (file) => JSON.parse(spawnSync(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }).stdout);

function pixel(file, t, x, y) {
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  return [...r.stdout.subarray(0, 3)];
}

const close = (a, b, tol = 20) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const sleep = (ms) => page.waitForTimeout(ms);
const saved = () => page.waitForSelector('.save-state:has-text("Saved")', { timeout: 6000 });

async function library() {
  return page.evaluate(() => window.api.library.get());
}

/** The project open in the editor, as stored on disk. */
async function storedDoc() {
  await saved();
  const lib = await library();
  const name = await page.inputValue('.project-name');
  const meta = lib.projects.find((p) => p.name === name && !p.trashedAt);
  return page.evaluate((id) => window.api.library.loadProject(id), meta.id);
}

async function newProject(files) {
  await home();
  await page.click('.sidebar .nav-item:has-text("Edit my footage")');
  await page.waitForSelector('.modal');
  if (files) {
    await stubOpenDialog(app, files);
    await page.click('.modal .dropzone');
    await page.waitForFunction((n) => document.querySelectorAll('.clip').length >= n, files.length, { timeout: 20000 });
    await sleep(400);
  } else {
    await page.click('.modal button:has-text("Start with an empty project")');
    await page.waitForSelector('.editor .tl-add-media');
  }
}

async function home() {
  if (await page.$('.editor')) await page.click('[aria-label="Back to Projects"]');
  await page.waitForSelector('.sidebar');
}

async function box(selector) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

async function drag(fromX, fromY, toX, toY, steps = 12) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps });
  await page.mouse.up();
  await sleep(120);
}

const clipSel = (id) => `.clip[data-clip="${id}"]`;
const readout = async () => (await page.textContent('.tl-time')).split('/')[0].trim();
const seconds = (text) => {
  const [m, s] = text.split(':');
  return Number(m) * 60 + Number(s);
};
const pxPerSec = async () => {
  const b = await box('.tl-tick:nth-child(2)');
  const a = await box('.tl-tick:nth-child(1)');
  const labels = await page.$$eval('.tl-tick', (e) => e.slice(0, 2).map((x) => x.textContent));
  return (b.x - a.x) / (seconds(labels[1]) - seconds(labels[0]));
};

/** Clicks the ruler at a timeline time. */
async function seekTo(t) {
  await page.click('.tl-toolbar button:has-text("Fit")');
  await sleep(100);
  const k = await pxPerSec();
  const ruler = await box('.tl-ruler');
  await page.mouse.click(ruler.x + 14 + t * k, ruler.y + 12);
  await sleep(80);
}

/** Exports the open project with the Export dialog as it stands. */
async function exportVideo(pg) {
  await pg.click('.editor-top button:has-text("Export")');
  await pg.click('.modal-foot button:has-text("Export")');
}

const sections = {};
const section = (name, fn) => (sections[name] = fn);

// ---------------------------------------------------------------- the editor and timeline article

section('timeline', async () => {
  await newProject([media('clip-a.mp4'), media('tone.mp3'), media('logo.png')]);
  let list = await clips(page);
  check(list.length === 3, 'uploading three files puts them on the timeline', `got ${list.length}`);
  check(new Set(list.map((c) => c.type)).size === 3, 'each kind of file is its own element');
  const video = list.find((c) => c.type === 'video');
  const audio = list.find((c) => c.type === 'audio');
  const image = list.find((c) => c.type === 'image');
  check(image.top < video.top && video.top < audio.top, 'images layer above footage and audio sits underneath', JSON.stringify(list));

  let doc = await storedDoc();
  check(doc.settings.width === 1280 && doc.settings.height === 720, 'the canvas adopts the size of the first video', `${doc.settings.width}x${doc.settings.height}`);
  await page.waitForSelector('.clip-tile', { timeout: 8000 });
  check((await page.$$('.clip-tile')).length > 3, 'video clips show a filmstrip');
  await page.waitForSelector('.clip.audio .clip-wave', { timeout: 8000 });
  check(true, 'audio clips show a waveform');
  await shot(page, '10-timeline-loaded');

  // Playhead and playback
  await seekTo(3);
  check(Math.abs(seconds(await readout()) - 3) < 0.15, 'clicking the ruler moves the playhead', await readout());
  const frame = await page.$eval('.stage video', (v) => v.currentTime);
  check(Math.abs(frame - 3) < 0.2, 'the canvas shows the frame under the playhead', String(frame));
  await page.click('.tl-play');
  await sleep(900);
  const during = await page.evaluate(() => {
    const v = document.querySelector('.stage video');
    const a = document.querySelector('audio');
    return { paused: v.paused, t: v.currentTime, audioPaused: a?.paused };
  });
  check(!during.paused && during.t > 3.3, 'play runs the video on the canvas', JSON.stringify(during));
  check(during.audioPaused === false, 'play runs the audio as well');
  await page.click('.tl-play');
  await sleep(150);
  const stopped = seconds(await readout());
  check(stopped > 3.4 && stopped < 5, 'pause stops at the current position', String(stopped));
  const headX = async () => Number(/translateX\(([\d.]+)px\)/.exec(await page.$eval('.tl-playhead', (e) => e.style.transform))[1]);
  const k0 = await pxPerSec();
  const x0 = await headX();
  await page.click('[aria-label^="Forward one frame"]');
  await sleep(60);
  const x1 = await headX();
  await page.click('[aria-label^="Back one frame"]');
  await sleep(60);
  const x2 = await headX();
  check(Math.abs(x1 - x0 - k0 / 30) < Math.max(1.5, k0 / 30), 'the forward button moves one frame', `${x0} -> ${x1}`);
  check(Math.abs(x2 - (x1 - k0 / 30)) < 0.5, 'the back button moves one frame', `${x1} -> ${x2}`);

  // Timeline size and zoom
  const h0 = (await box('.editor-timeline')).height;
  const line = await box('.tl-resizer');
  await drag(line.x + 300, line.y + 2, line.x + 300, line.y - 80);
  const h1 = (await box('.editor-timeline')).height;
  check(h1 > h0 + 60, 'dragging the line above the timeline enlarges it', `${h0} -> ${h1}`);
  const fitWidth = (await box(clipSel(video.id))).width;
  await page.click('[aria-label="Zoom in"]');
  await sleep(100);
  check((await box(clipSel(video.id))).width > fitWidth * 1.2, 'zooming in stretches the clips');
  await page.click('.tl-toolbar button:has-text("Fit")');
  await sleep(100);

  // Select, right-click, trim
  let b = await box(clipSel(video.id));
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(100);
  check((await clips(page)).find((c) => c.id === video.id).selected, 'clicking an element selects it');
  check(await page.isVisible('.inspector >> text=Speed'), 'selecting an element opens its options');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await page.waitForSelector('.menu');
  const items = await page.$$eval('.menu-item span:first-of-type', (e) => e.map((x) => x.textContent));
  for (const label of ['Split clip', 'Copy', 'Paste', 'Replace media…', 'Delete']) check(items.includes(label), `right-click offers ${label}`);
  check(items.some((i) => i.startsWith('Export section')), 'right-click offers Export section');
  await shot(page, '11-context-menu');
  await page.keyboard.press('Escape');

  const k = await pxPerSec();
  await drag(b.x + b.width - 3, b.y + 20, b.x + b.width - 3 - 1 * k, b.y + 20);
  doc = await storedDoc();
  let v = doc.items.find((i) => i.type === 'video');
  // A pixel is about 0.1 seconds at this zoom, so these allow for rounding on both ends of a drag.
  check(Math.abs(v.duration - 5) < 0.25, 'dragging the end handle trims the clip', String(v.duration));
  b = await box(clipSel(video.id));
  await drag(b.x + 3, b.y + 20, b.x + 3 + 1 * k, b.y + 20);
  doc = await storedDoc();
  v = doc.items.find((i) => i.type === 'video');
  check(Math.abs(v.trimStart - 1) < 0.25 && Math.abs(v.start - 1) < 0.25 && Math.abs(v.duration - 4) < 0.35, 'dragging the start handle trims from the front', JSON.stringify({ s: v.start, t: v.trimStart, d: v.duration }));
  b = await box(clipSel(video.id));
  await drag(b.x + b.width - 3, b.y + 20, b.x + b.width + 6 * k, b.y + 20);
  doc = await storedDoc();
  v = doc.items.find((i) => i.type === 'video');
  check(Math.abs(v.trimStart + v.duration - 6) < 0.1, 'trimming cannot run past the end of the footage', String(v.trimStart + v.duration));
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);
  doc = await storedDoc();
  v = doc.items.find((i) => i.type === 'video');
  check(Math.abs(v.duration - 6) < 0.05 && v.trimStart === 0, 'undo restores the original clip', JSON.stringify({ d: v.duration, t: v.trimStart }));

  // Split, delete, gaps
  b = await box(clipSel(video.id));
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await seekTo(2);
  await page.keyboard.press('s');
  await sleep(100);
  await seekTo(4);
  b = await box(clipSel(video.id));
  await page.mouse.click(b.x + 20, b.y + 20);
  await page.click('.tl-toolbar button:has-text("Split")');
  await sleep(100);
  list = (await clips(page)).filter((c) => c.type === 'video').sort((x, y) => x.left - y.left);
  check(list.length === 2 || list.length === 3, 'S and the Split button cut clips', String(list.length));
  // Whatever the selection, leave exactly three pieces: 0-2, 2-4, 4-6.
  if (list.length === 2) {
    await page.keyboard.press('Escape');
    await seekTo(4);
    const piece = list[1];
    const pb = await box(clipSel(piece.id));
    await page.mouse.click(pb.x + 20, pb.y + 20);
    await seekTo(4);
    await page.keyboard.press('s');
    await sleep(100);
    list = (await clips(page)).filter((c) => c.type === 'video').sort((x, y) => x.left - y.left);
  }
  check(list.length === 3, 'splitting twice leaves three pieces', String(list.length));
  doc = await storedDoc();
  const pieces = doc.items.filter((i) => i.type === 'video').sort((x, y) => x.start - y.start);
  check(Math.abs(pieces[1].trimStart - 2) < 0.05 && Math.abs(pieces[2].trimStart - 4) < 0.05, 'each piece keeps its place in the footage', JSON.stringify(pieces.map((p) => p.trimStart)));

  const mid = await box(clipSel(list[1].id));
  await page.mouse.click(mid.x + mid.width / 2, mid.y + mid.height / 2);
  await page.keyboard.press('Delete');
  await sleep(120);
  check((await clips(page)).filter((c) => c.type === 'video').length === 2, 'Delete removes the selected element');
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2);
  await sleep(120);
  check(!!(await page.$('.tl-gap')), 'hovering an empty space highlights it');
  await page.mouse.click(mid.x + mid.width / 2, mid.y + mid.height / 2);
  await sleep(120);
  await shot(page, '12-gap-selected');
  await page.keyboard.press('Delete');
  await sleep(150);
  doc = await storedDoc();
  const closed = doc.items.filter((i) => i.type === 'video').sort((x, y) => x.start - y.start);
  check(Math.abs(closed[1].start - 2) < 0.05, 'deleting an empty space closes it', String(closed[1].start));

  // Moving, snapping, layers
  const parts = (await clips(page)).filter((c) => c.type === 'video').sort((x, y) => x.left - y.left);
  const last = await box(clipSel(parts[1].id));
  const k2 = await pxPerSec();
  await drag(last.x + 30, last.y + 25, last.x + 30 + 3 * k2, last.y + 25);
  doc = await storedDoc();
  let moved = doc.items.find((i) => i.id === parts[1].id);
  check(Math.abs(moved.start - 5) < 0.2, 'dragging sideways changes when an element plays', String(moved.start));
  const moved2 = await box(clipSel(parts[1].id));
  // Drop it just past the first piece: it should snap to join it exactly.
  await drag(moved2.x + 30, moved2.y + 25, moved2.x + 30 - 3 * k2 + 5, moved2.y + 25);
  doc = await storedDoc();
  moved = doc.items.find((i) => i.id === parts[1].id);
  const first = doc.items.find((i) => i.id === parts[0].id);
  check(Math.abs(moved.start - (first.start + first.duration)) < 1e-6, 'snapping joins elements exactly', `${moved.start} vs ${first.start + first.duration}`);
  const tracksBefore = doc.tracks.length;
  const p2 = await box(clipSel(parts[1].id));
  const top = await box('.tl-new-track');
  const startBefore = moved.start;
  await drag(p2.x + 30, p2.y + 25, p2.x + 30 - 1 * k2, top.y + 6);
  doc = await storedDoc();
  check(doc.tracks.length === tracksBefore + 1, 'dragging above the top track creates a new layer', `${tracksBefore} -> ${doc.tracks.length}`);
  const lifted = doc.items.find((i) => i.id === parts[1].id);
  check(doc.tracks[0].id === lifted.trackId, 'the element lands on the new top layer');
  check(Math.abs(lifted.start - (startBefore - 1)) < 0.25, 'and stays where it was dropped, even over another clip', `${startBefore} -> ${lifted.start}`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);

  // Named rows
  const rowNames = await page.$$eval('.tl-head-name', (e) => e.map((x) => x.textContent));
  check(rowNames.includes('Video') && rowNames.includes('Audio') && rowNames.includes('Picture'), 'each row is named after what is on it', rowNames.join());
  await page.click('[aria-label="Hide the picture of Video"]');
  await sleep(150);
  await seekTo(1);
  await sleep(150);
  check((await page.$eval('.stage video', (v) => v.style.visibility)) === 'hidden', 'a row can be hidden');
  doc = await storedDoc();
  check(doc.tracks.some((t) => t.hidden), 'and that is saved with the project');
  await page.click('[aria-label="Show the picture of Video"]');
  await page.click('[aria-label="Mute Video"]');
  await sleep(150);
  check(await page.$eval('.stage video', (v) => v.muted), 'a row can be muted');
  await page.click('[aria-label="Unmute Video"]');
  await page.click('.tl-head:has-text("Video")', { button: 'right' });
  await page.click('.menu-item:has-text("Rename row")');
  await page.fill('.modal input', 'Main');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tl-head-name:has-text("Main")');
  check(true, 'a row can be renamed');

  // Grouping
  const g1 = await box(clipSel(parts[0].id));
  const g2 = await box(clipSel(audio.id));
  await page.mouse.click(g1.x + 30, g1.y + 25);
  await page.keyboard.down(MOD);
  await page.mouse.click(g2.x + 30, g2.y + 20);
  await page.keyboard.up(MOD);
  await sleep(100);
  check(await page.isVisible('.inspector >> text=2 clips'), 'Ctrl or Cmd click selects several elements');
  await page.click('.tl-toolbar button:has-text("Group")');
  await sleep(100);
  await page.keyboard.press('Escape');
  await page.mouse.click(g2.x + 30, g2.y + 20);
  await sleep(100);
  check((await clips(page)).filter((c) => c.selected).length === 2, 'clicking one group member selects the group');
  await shot(page, '13-grouped');
  const k3 = await pxPerSec();
  const a0 = (await box(clipSel(audio.id))).x;
  const v0 = (await box(clipSel(parts[0].id))).x;
  await drag(g2.x + 30, g2.y + 20, g2.x + 30 + 1.5 * k3, g2.y + 20);
  check(Math.abs((await box(clipSel(audio.id))).x - a0 - ((await box(clipSel(parts[0].id))).x - v0)) < 2, 'grouped elements move together');
  await page.click('.tl-toolbar button:has-text("Ungroup")');
  await sleep(100);
  check(!(await page.$('.tl-toolbar button:has-text("Ungroup")')), 'Ungroup separates them');

  // Copy and paste, duplicate
  const count = (await clips(page)).length;
  await page.keyboard.press(`${MOD}+c`);
  await page.keyboard.press('Escape');
  await seekTo(0.2);
  await page.keyboard.press(`${MOD}+v`);
  await sleep(150);
  check((await clips(page)).length === count + 2, 'copy and paste', `${count} -> ${(await clips(page)).length}`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);
  check((await clips(page)).length === count, 'paste can be undone');
});

// Behaviour that came out of the design review of 0.1.0.
section('start', async () => {
  // A first run lands on the ways to start something, with nothing to fill in.
  check(!!(await page.$('.start-tile:has-text("Edit my footage")')) && (await page.$$('.start-tile')).length === 4, 'the first run lands on the start page');
  await shot(page, '09-start-page');
});

section('review', async () => {
  // Help can find an action by the word you would use for it, and run it.
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForSelector('.modal .help-search input');
  check((await page.$$('.help-topics details')).length >= 6, 'How do I lists the common jobs');
  await page.fill('.modal .help-search input', 'accounts');
  await page.waitForSelector('.help-action:has-text("AI connections")');
  check(true, 'it finds actions by other words for them');
  await page.fill('.modal .help-search input', 'extract audio');
  await page.waitForSelector('.help-topics summary:has-text("Take the sound out of a video")');
  check(true, 'and how-to topics');
  await page.fill('.modal .help-search input', 'templates');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.page-head h1:has-text("Templates")');
  check(true, 'Enter runs the first action found');

  // Files dropped on the dashboard start a project.
  await home();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'drop-source';
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles('#drop-source', media('clip-b.mp4'));
  await page.evaluate(() => {
    const input = document.getElementById('drop-source');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(input.files[0]);
    const target = document.querySelector('.shell-main');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    input.remove();
  });
  await page.waitForSelector('.editor .clip.video', { timeout: 10000 });
  check((await page.inputValue('.project-name')).startsWith('clip-b'), 'a file dropped on the dashboard starts a project with it');

  // Nothing is created until there is something to put in it.
  await home();
  const projectCount = async () => (await library()).projects.length;
  const before = await projectCount();
  await page.click('.sidebar .nav-item:has-text("Edit my footage")');
  await page.waitForSelector('.modal');
  await page.click('.modal [aria-label="Close"]');
  await sleep(150);
  check((await projectCount()) === before && !(await page.$('.editor')), 'closing the start dialog leaves no project behind');
  await newProject();
  check((await projectCount()) === before + 1, 'an empty project can be asked for');
  await home();
  await page.waitForFunction((n) => window.api.library.get().then((l) => l.projects.length === n), before, { timeout: 3000 }).catch(() => undefined);
  check((await projectCount()) === before, 'and goes away again if nothing was put in it');
  await newProject();
  await stubOpenDialog(app, [media('clip-b.mp4')]);
  await page.click('.tl-add-media');
  await page.waitForSelector('.clip.video');
  await sleep(100);
  check((await page.inputValue('.project-name')).startsWith('clip-b'), 'an empty project takes its name from the first file added', await page.inputValue('.project-name'));
  await newProject([media('clip-a.mp4')]);
  check((await page.inputValue('.project-name')).startsWith('clip-a'), 'a project is named after its first file', await page.inputValue('.project-name'));
  const videos = async () => (await clips(page)).filter((c) => c.type === 'video').sort((a, b) => a.left - b.left);
  let list = await videos();
  const b0 = await box(clipSel(list[0].id));
  await page.mouse.click(b0.x + b0.width / 2, b0.y + 20);
  await seekTo(2);
  await page.keyboard.press('s');
  await sleep(120);
  list = await videos();
  check(list.length === 2, 'S splits the selected clip', String(list.length));
  const left = await box(clipSel(list[0].id));
  await page.mouse.click(left.x + 10, left.y + 20);
  await seekTo(4);
  await page.keyboard.press('s');
  await sleep(120);
  check((await videos()).length === 3, 'Split cuts the clip under the playhead when the selected clip is not there', String((await videos()).length));
  await seekTo(5.99);
  await page.keyboard.press('End');
  await sleep(100);
  await page.keyboard.press('s');
  await page.waitForSelector('.toast:has-text("no clip under the playhead")', { timeout: 3000 });
  check(true, 'Split says why when there is nothing to cut');

  list = await videos();
  const lastPiece = await box(clipSel(list[2].id));
  await page.mouse.click(lastPiece.x + 20, lastPiece.y + 20);
  await page.keyboard.press('Delete');
  await sleep(150);
  check(Math.abs(seconds(await readout()) - 4) < 0.1, 'the playhead comes back to the new end after a delete', await readout());

  // Extract audio
  await newProject([media('clip-a.mp4')]);
  const original = (await videos())[0];
  const ob = await box(clipSel(original.id));
  await page.mouse.click(ob.x + ob.width / 2, ob.y + 20, { button: 'right' });
  await page.click('.menu-item:has-text("Extract audio")');
  await page.waitForSelector('.clip.audio', { timeout: 15000 });
  await sleep(150);
  let withSound = await storedDoc();
  const pulled = withSound.items.find((i) => i.type === 'audio');
  const muted = withSound.items.find((i) => i.type === 'video');
  check(muted.muted && Math.abs(pulled.duration - muted.duration) < 0.05 && pulled.start === muted.start, 'Extract audio lines the sound up under the video and mutes the video', JSON.stringify({ a: pulled.duration, v: muted.duration }));
  check((await library()).assets.some((a) => a.kind === 'audio' && a.id === pulled.assetId), 'the sound is a real audio item');
  await page.click(clipSel(original.id));
  await page.keyboard.press('Delete');
  await sleep(150);
  withSound = await storedDoc();
  check(withSound.items.length === 1 && withSound.items[0].type === 'audio', 'deleting the video leaves the sound');
  await page.keyboard.press(`${MOD}+z`);
  await sleep(100);
  await page.click('.rail-item:has-text("Audio")');
  await page.click('.panel button:has-text("Extract audio from a video")');
  await page.waitForSelector('.menu-item:has-text("clip-a.mp4")');
  check(true, 'the Audio panel offers Extract audio too');
  await page.keyboard.press('Escape');

  // One library: what went into a project is in Media and in every other project.
  await home();
  await page.click('.sidebar .nav-item:has-text("Media")');
  await page.waitForSelector('.asset-card:has-text("clip-a.mp4")');
  check(await page.isVisible('.asset-card:has-text("clip-a sound.flac")'), 'Media holds what was added and extracted in a project');
  await page.click('.asset-card:has-text("clip-a.mp4") .asset-card-picture');
  await page.waitForSelector('.modal .preview-stage video');
  const preview = await page.evaluate(async () => {
    const v = document.querySelector('.preview-stage video');
    if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; setTimeout(r, 4000); });
    return v.videoWidth;
  });
  check(preview === 1280, 'clicking something in Media previews it', String(preview));
  await shot(page, '35-media-preview');
  const offers = await page.$$eval('.modal-foot button', (e) => e.map((b) => b.textContent));
  check(offers.some((o) => o.startsWith('Use in')) && offers.includes('Start a project') && offers.includes('Extract audio'), 'and offers what to do with it', offers.join());
  await page.click('.modal-foot button:has-text("Use in")');
  await page.waitForFunction(() => document.querySelectorAll('.editor .clip.video').length >= 1, null, { timeout: 8000 });
  check(true, 'Use in adds it to the last project');
  await home();
  await newProject();
  await page.click('.rail-item:has-text("Media")');
  check((await page.textContent('.panel')).includes('clip-a.mp4'), 'and another project can use it');

  // The start dialog offers what is already in Media.
  await home();
  await page.click('.sidebar .nav-item:has-text("Edit my footage")');
  await page.click('.welcome-media .asset-tile:has-text("clip-a.mp4")');
  await page.waitForSelector('.editor .clip.video', { timeout: 8000 });
  check(true, 'a project can start from something already in Media');

  // Media tiles add at the playhead, as they say they do.
  await newProject([media('clip-a.mp4')]);
  await page.click('.rail-item:has-text("Media")');
  await seekTo(1);
  await page.click('.asset-tile:has-text("clip-a.mp4")');
  await sleep(200);
  let doc = await storedDoc();
  const added = doc.items.filter((i) => i.type === 'video').sort((a, b) => b.id.localeCompare(a.id));
  const overlay = doc.items.find((i) => i.trackId === doc.tracks[0].id);
  check(doc.tracks.length === 2 && Math.abs(overlay.start - 1) < 0.05, 'a video tile goes at the playhead, on a new row over the footage', JSON.stringify(added.map((i) => i.start)));
  await page.click('.asset-tile:has-text("clip-a.mp4")');
  await sleep(200);
  doc = await storedDoc();
  const onRow = doc.items.filter((i) => i.trackId === doc.tracks[0].id).sort((a, b) => a.start - b.start);
  check(onRow.length === 2 && Math.abs(onRow[1].start - (onRow[0].start + onRow[0].duration)) < 0.05, 'clicking on builds a sequence after it', JSON.stringify(onRow.map((i) => i.start)));
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(100);

  // New text fits the video instead of lengthening it.
  await newProject([media('clip-b.mp4')]);
  const footage = (await storedDoc()).items[0].duration;
  await page.click('.rail-item:has-text("Text")');
  await page.click('button:has-text("Add a heading")');
  await sleep(200);
  doc = await storedDoc();
  const heading = doc.items.find((i) => i.type === 'text');
  check(Math.abs(heading.duration - Math.min(5, footage)) < 0.05, 'new text lasts no longer than the video', `${heading.duration} on ${footage}`);
  await page.fill('[aria-label="Length"]', '00:09.0');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.notice.warning:has-text("past the end of your video")');
  await page.click('button:has-text("End with the video")');
  await sleep(150);
  check(!(await page.$('.notice.warning')), 'a warning offers to end text with the video');
  check(Math.abs((await storedDoc()).items.find((i) => i.type === 'text').duration - footage) < 0.05, 'and does it');

  // Moving and trimming are separate, and say which is which.
  const video = (await videos())[0];
  await page.click(clipSel(video.id));
  await page.fill('[aria-label="Starts at"]', '00:01.0');
  await page.keyboard.press('Enter');
  await sleep(100);
  await page.fill('[aria-label="Plays to"]', '00:02.0');
  await page.keyboard.press('Enter');
  await sleep(150);
  const cut = (await storedDoc()).items.find((i) => i.type === 'video');
  check(Math.abs(cut.start - 1) < 0.05 && Math.abs(cut.duration - 2) < 0.05, 'Starts at moves the clip and Plays to trims it', JSON.stringify({ s: cut.start, d: cut.duration }));
});

section('text', async () => {
  await newProject([media('clip-b.mp4')]);
  await page.click('.rail-item:has-text("Text")');
  await page.click('button:has-text("Add a heading")');
  await sleep(200);
  check(!!(await page.$('.clip.text')), 'adding text puts an element on the timeline');
  check(await page.isVisible('.stage-selection'), 'the new text is selected on the canvas');
  await page.fill('.inspector textarea', 'Launch day');
  await sleep(100);
  const sel = await box('.stage-selection');
  const frame = await box('.stage-frame');
  check(Math.abs(sel.x + sel.width / 2 - (frame.x + frame.width / 2)) < 3, 'text starts centred on the canvas');
  // Not so far that the box runs off the window, or its handles could not be reached below.
  await drag(sel.x + sel.width / 2, sel.y + sel.height / 2, sel.x + sel.width / 2 + 60, sel.y + sel.height / 2 - 120);
  const after = await box('.stage-selection');
  check(after.x > sel.x + 40, 'text can be dragged on the canvas', `${sel.x} -> ${after.x}`);
  const w0 = after.width;
  const handle = await box('.stage-handle.se');
  await drag(handle.x + 5, handle.y + 5, handle.x - 120, handle.y - 40);
  const resized = await box('.stage-selection');
  check(resized.width < w0, 'corner handles resize it', JSON.stringify({ w0, after, handle, resized }));
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);
  // Back at the centre: colour it so the export can be checked pixel by pixel.
  await page.selectOption('.inspector select[aria-label="Font"]', 'Impact');
  await page.fill('.inspector [aria-label="Text colour hex value"]', '#ffee00');
  await page.keyboard.press('Tab');
  await sleep(100);
  await shot(page, '14-text');

  // Subtitles from a file
  await page.keyboard.press('Escape');
  await page.click('.rail-item:has-text("Subtitles")');
  await stubOpenDialog(app, [media('subs.srt')]);
  await page.click('button:has-text("Add SRT or VTT")');
  await page.waitForSelector('.cue', { timeout: 5000 });
  check((await page.$$('.cue')).length === 3, 'importing an SRT adds its cues', String((await page.$$('.cue')).length));
  await page.click('.subtitle-style:has-text("Boxed")');
  await sleep(150);
  await shot(page, '15-subtitles');
  const doc = await storedDoc();
  const cues = doc.items.filter((i) => i.type === 'text' && i.subtitle);
  check(cues.length === 3 && cues.every((c) => c.style.bgColor === '#000000'), 'a subtitle style applies to every cue');
  check(Math.abs(cues[0].start - 0.5) < 0.05 && Math.abs(cues[0].duration - 1.5) < 0.05, 'cues keep their timing', JSON.stringify([cues[0].start, cues[0].duration]));
  await page.fill('.cue textarea >> nth=0', 'Edited line');
  await sleep(1100);
  check((await storedDoc()).items.some((i) => i.text === 'Edited line'), 'cue text can be edited');
});

section('export', async () => {
  await newProject([media('clip-a.mp4')]);
  await page.click('.rail-item:has-text("Text")');
  await page.click('button:has-text("Add a heading")');
  await sleep(150);
  await page.fill('.inspector textarea', 'EXPORT');
  await page.fill('.inspector [aria-label="Text colour hex value"]', '#ff00ff');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');

  // The Export dialog: nothing starts until it has been filled in.
  await page.click('.editor-top button:has-text("Export")');
  await page.waitForSelector('.modal select[aria-label="Export quality"]');
  await sleep(300);
  await shot(page, '16-export-dialog');
  const onTop = await page.evaluate(() => {
    // Nothing from the canvas may show through a dialog.
    const b = document.querySelector('.modal').getBoundingClientRect();
    return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height - 4)?.closest('.modal');
  });
  check(onTop, 'dialogs sit above the canvas');
  const options = await page.$$eval('.modal select[aria-label="Export quality"] option', (e) => e.map((x) => x.textContent));
  check(options.some((o) => o.startsWith('YouTube 1080p')), 'YouTube presets are offered');
  check((await page.inputValue('.modal select[aria-label="Export quality"]')) === 'match', 'it starts from the size of the footage');
  check((await page.textContent('.modal')).includes('1280 × 720'), 'and says what will be exported');
  await page.click('.modal .link-btn:has-text("Advanced")');
  await page.selectOption('.modal select[aria-label="Export resolution"]', '1080');
  await sleep(100);
  check((await page.textContent('.modal')).includes('1920 × 1080'), 'Advanced changes the resolution');
  check((await page.textContent('.modal')).includes('does not add detail'), 'exporting above the source resolution is explained');
  await page.selectOption('.modal select[aria-label="Export quality"]', 'standard');
  await sleep(100);

  await page.click('.modal-foot button:has-text("Export")');
  await page.waitForSelector('.video-page', { timeout: 10000 });
  await page.waitForSelector('.video-player', { timeout: 60000 });
  await sleep(300);
  await shot(page, '17-video-page');

  const lib = await library();
  const meta = lib.projects.find((p) => p.lastExport);
  check(!!meta, 'the project records its export');
  const file = join(dir, 'library', 'exports', meta.id, meta.lastExport.file);
  check(existsSync(file), 'the exported file exists');
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  check(v.codec_name === 'h264' && v.pix_fmt === 'yuv420p', 'video is H.264', v.codec_name);
  check(v.color_space === 'bt709', 'colour space is bt709', v.color_space);
  check(a?.codec_name === 'aac', 'audio is AAC', a?.codec_name);
  check(v.width === 1280 && v.height === 720, 'the chosen resolution is used', `${v.width}x${v.height}`);
  check(Math.abs(Number(info.format.duration) - 6) < 0.1, 'length matches the project', info.format.duration);

  // The text drawn on the canvas really is in the video: magenta strokes around the middle of the frame.
  let found = false;
  for (let x = 440; x < 840 && !found; x += 6) found = close(pixel(file, 2, x, 360), [255, 0, 255], 60);
  check(found, 'text from the canvas is in the exported video');

  const playable = await page.evaluate(async () => {
    const v2 = document.querySelector('.video-player');
    if (v2.readyState < 2) await new Promise((r) => (v2.onloadeddata = r));
    v2.muted = true;
    await v2.play();
    await new Promise((r) => setTimeout(r, 400));
    v2.pause();
    return { w: v2.videoWidth, t: v2.currentTime };
  });
  check(playable.w === 1280 && playable.t > 0.1, 'the finished video plays on the video page', JSON.stringify(playable));

  // Downloads
  for (const [format, title] of [['mp4', 'MP4'], ['mp3', 'MP3'], ['gif', 'GIF']]) {
    const target = join(dir, `download.${format}`);
    await stubSaveDialog(app, target);
    await page.click(`.download-option:has-text("${title}")`);
    await page.waitForSelector(`.toast:has-text("Saved ${title}")`, { timeout: 30000 });
    check(existsSync(target) && statSync(target).size > 1000, `${title} download is saved`);
    const p = probe(target);
    const stream = p.streams[0].codec_name;
    if (format === 'mp3') check(stream === 'mp3' && p.streams.length === 1, 'MP3 holds only audio', stream);
    if (format === 'gif') check(stream === 'gif', 'GIF is a GIF', stream);
  }

  // A finished video can go back into Media, ready for another project.
  await page.click('.video-side button:has-text("Add to Media")');
  await page.waitForSelector('.toast:has-text("is in Media")', { timeout: 8000 });
  check((await library()).assets.some((a) => a.name === `${meta.name}.mp4`), 'an export can be added to Media');

  // Further edits make the export stale
  await page.click('.page-head button:has-text("Edit")');
  await page.waitForSelector('.clip');
  await page.click('.rail-item:has-text("Text")');
  await page.click('button:has-text("Add body text")');
  await saved();
  await home();
  const stale = (await library()).projects.find((p) => p.id === meta.id);
  check(stale.editedSinceExport, 'editing after an export marks it out of date');

  // Section download
  await page.click(`.recent:has-text("${stale.name}")`);
  await page.waitForSelector('.clip.video');
  await page.waitForFunction(() => document.querySelectorAll('.clip').length >= 3);
  const c = (await clips(page)).find((x) => x.type === 'video');
  const b = await box(clipSel(c.id));
  await page.mouse.click(b.x + 60, b.y + 25);
  await seekTo(3);
  await page.keyboard.press('s');
  await sleep(150);
  const target = join(dir, 'section.mp4');
  await stubSaveDialog(app, target);
  const right = (await clips(page)).filter((x) => x.type === 'video').sort((x, y) => y.left - x.left)[0];
  const rb = await box(clipSel(right.id));
  await page.mouse.click(rb.x + 40, rb.y + 25);
  await sleep(120);
  await page.click('.tl-toolbar button:has-text("Export section")');
  await page.click('.modal-foot button:has-text("Export")');
  await page.waitForSelector('.toast:has-text("Export saved")', { timeout: 60000 });
  const section2 = probe(target);
  check(Math.abs(Number(section2.format.duration) - 3) < 0.2, 'Export section renders only the selected part', section2.format.duration);

  // Sound straight from the dialog, without rendering any picture.
  const soundFile = join(dir, 'whole-sound.mp3');
  await stubSaveDialog(app, soundFile);
  await page.click('.editor-top button:has-text("Export")');
  await page.click('.modal .segmented button:has-text("Sound only")');
  await page.click('.modal .segmented button:has-text("A stretch of time")');
  await page.fill('.modal [aria-label="Export from"]', '00:01.0');
  await page.keyboard.press('Tab');
  await page.fill('.modal [aria-label="Export up to"]', '00:03.0');
  await page.keyboard.press('Tab');
  await page.click('.modal-foot button:has-text("Export")');
  await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0 && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Export saved')), null, { timeout: 30000 });
  await sleep(200);
  const sound = probe(soundFile);
  check(sound.streams.length === 1 && sound.streams[0].codec_name === 'mp3' && Math.abs(Number(sound.format.duration) - 2) < 0.2, 'the dialog exports a stretch as sound only', JSON.stringify(sound.format?.duration));
});

section('formats', async () => {
  // Formats Chromium cannot play get a preview proxy, and every one of them must still appear on the canvas.
  await newProject();
  await stubOpenDialog(app, [media('old.avi'), media('prores.mov'), media('flash.flv'), media('anim.gif')]);
  await page.click('.tl-add-media');
  await page.waitForFunction(() => document.querySelectorAll('.clip').length >= 4, null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.stage-placeholder'), null, { timeout: 40000 });
  const ok = await page.evaluate(async () => {
    const v = document.querySelector('.stage video');
    if (!v) return 'no video element';
    if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 4000); });
    return v.videoWidth > 0 ? 'ok' : `no picture ${v.error?.message ?? ''}`;
  });
  check(ok === 'ok', 'a proxy makes AVI playable in the editor', ok);
  await shot(page, '18-proxy');

  await home();
  await page.click('.sidebar .nav-item:has-text("Media")');
  await stubOpenDialog(app, [media('notes.txt'), media('pic.webp'), media('pic.avif'), media('tone.flac')]);
  await page.click('button:has-text("Add files")');
  await page.waitForSelector('.toast.error', { timeout: 8000 });
  check((await page.textContent('.toast.error')).includes('notes.txt'), 'unsupported files are refused with a reason');
  await page.waitForFunction(() => ['pic.webp', 'pic.avif', 'tone.flac'].every((n) => [...document.querySelectorAll('.asset-card')].some((c) => c.textContent.includes(n))), null, { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.asset-card-picture.image img')].length >= 2, null, { timeout: 8000 });
  check(true, 'uploads land in Media, with previews');
  await shot(page, '19-assets');
  await newProject();
  await page.click('.rail-item:has-text("Media")');
  check((await page.textContent('.panel')).includes('pic.avif'), 'workspace assets are available inside a project');
  await page.click('.asset-tile:has-text("pic.webp")');
  await sleep(300);
  check((await clips(page)).length === 1, 'clicking an asset adds it to the timeline');
});

section('library', async () => {
  await home();
  await page.click('.sidebar .nav-item:has-text("Projects")');
  await page.waitForSelector('.project-card');
  const count = (await page.$$('.project-card')).length;
  check(count >= 1, 'View all shows the projects');
  await shot(page, '20-library');
  const seed = (await library()).projects.find((p) => !p.trashedAt && p.duration > 0);

  // Rename
  const card = page.locator('.project-card', { hasText: seed.name }).first();
  await card.hover();
  await card.locator('[aria-label^="More options"]').click();
  await page.waitForSelector('.menu');
  const labels = await page.$$eval('.menu-item span:first-of-type', (e) => e.map((x) => x.textContent));
  for (const l of ['Edit', 'Rename', 'Duplicate', 'Move', 'Save as a template', 'Save video', 'Move to Trash']) check(labels.includes(l), `the project menu has ${l}`);
  await shot(page, '21-project-menu');
  await page.click('.menu-item:has-text("Rename")');
  await page.fill('.modal input', 'Launch film');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.project-card:has-text("Launch film")');
  check(true, 'projects can be renamed');

  // Duplicate
  const named = page.locator('.project-card', { hasText: 'Launch film' }).first();
  await named.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Duplicate")');
  await page.waitForSelector('.project-card:has-text("Launch film copy")');
  check(true, 'projects can be duplicated');

  // Spaces and folders: a second space is what brings spaces into view.
  check((await page.textContent('.page-head h1')) === 'Projects' && !(await page.$('.space-switcher')), 'spaces stay out of sight while there is only one');
  await page.click('[aria-label="Project options"]');
  await page.click('.menu-item:has-text("New space")');
  await page.fill('.modal input', 'Marketing');
  await page.keyboard.press('Enter');
  await page.waitForSelector('h1:has-text("Marketing")');
  await page.click('[aria-label="Space options"]');
  await page.click('.menu-item:has-text("New folder")');
  await page.fill('.modal input', 'Campaigns');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.folder-card:has-text("Campaigns")');
  check(true, 'spaces and folders can be created');

  // Move several at once
  await page.click('.space-switcher');
  await page.click('.menu-item:has-text("All projects")');
  await page.waitForSelector('.project-card');
  for (const text of [/Launch film copy/, /Launch film(?! copy)/]) {
    const c = page.locator('.project-card', { hasText: text }).first();
    await c.hover();
    await c.locator('.project-check').click();
  }
  await page.waitForSelector('.selection-bar');
  await shot(page, '22-multi-select');
  check((await page.textContent('.selection-bar')).includes('2 selected'), 'ticking cards selects several projects');
  await page.click('.selection-bar button:has-text("Move")');
  await page.waitForSelector('.modal');
  const marketing = (await library()).spaces.find((s) => s.name === 'Marketing');
  await page.locator('.modal select').nth(0).selectOption(marketing.id);
  await sleep(80);
  await page.locator('.modal select').nth(1).selectOption({ index: 1 });
  await page.click('.modal-foot button:has-text("Move")');
  await sleep(250);
  const movedLib = await library();
  const moved = movedLib.projects.filter((p) => p.name.startsWith('Launch film'));
  check(moved.length === 2 && moved.every((p) => p.spaceId === marketing.id && p.folderId), 'projects move to the chosen space and folder');

  // Template
  await page.click('.space-switcher');
  await page.click('.menu-item:has-text("Marketing")');
  await page.waitForSelector('.folder-card');
  await page.click('.folder-open');
  await page.waitForSelector('.project-card:has-text("Launch film")');
  check((await page.$$('.project-card')).length === 2, 'the folder shows what was moved into it');
  const c2 = page.locator('.project-card', { hasText: 'Launch film copy' }).first();
  await c2.hover();
  await c2.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Save as a template")');
  await page.fill('.modal input', 'My layout');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("Template saved")');
  await page.click('.sidebar .nav-item:has-text("Templates")');
  await page.waitForSelector('.project-card:has-text("My layout")');
  await page.click('.project-card:has-text("My layout") .project-thumb');
  await page.waitForSelector('.clip', { timeout: 10000 });
  check(true, 'a template starts a new project with its contents');
  await home();

  // Trash
  await page.click('.sidebar .nav-item:has-text("Projects")');
  await page.waitForSelector('.project-card');
  const t = page.locator('.project-card', { hasText: 'Launch film copy' }).first();
  await t.hover();
  await t.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Move to Trash")');
  await page.waitForSelector('.toast:has-text("moved to Trash")');
  await page.click('.space-switcher');
  await page.click('.menu-item:has-text("Trash")');
  await page.waitForSelector('.project-card:has-text("Launch film copy")');
  check((await page.textContent('.project-card')).includes('Deleted in 30 days'), 'Trash shows how long a project is kept');
  await shot(page, '23-trash');
  const tc = page.locator('.project-card', { hasText: 'Launch film copy' }).first();
  await tc.hover();
  await tc.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Restore")');
  await page.waitForFunction(() => !document.querySelector('.project-card'));
  check(!(await library()).projects.find((p) => p.name === 'Launch film copy').trashedAt, 'Restore brings a project back');

  const id = (await library()).projects.find((p) => p.name === 'Launch film copy').id;
  await page.evaluate((x) => window.api.library.trashProjects([x]), id);
  await page.waitForSelector('.project-card');
  const tc2 = page.locator('.project-card').first();
  await tc2.hover();
  await tc2.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Delete permanently")');
  await page.waitForSelector('.modal');
  check((await page.textContent('.modal')).includes('cannot be undone'), 'permanent deletion asks first');
  await page.click('.modal-foot button:has-text("Delete permanently")');
  await page.waitForFunction(() => !document.querySelector('.project-card'));
  check(!(await library()).projects.some((p) => p.id === id), 'Delete permanently removes the project');
  check(!existsSync(join(dir, 'library', 'projects', `${id}.json`)), 'its file is gone from disk');

  // Draft projects cannot be downloaded
  await page.click('.space-switcher');
  await page.click('.menu-item:has-text("All projects")');
  await page.waitForSelector('.project-card');
  const draft = (await library()).projects.find((p) => !p.trashedAt && !p.lastExport);
  const dc = page.locator('.project-card', { hasText: draft.name }).first();
  await dc.hover();
  await dc.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Save video")');
  await page.waitForSelector('.toast:has-text("still a draft")');
  check(true, 'a draft has to be exported before it can be downloaded');
});

section('persistence', async () => {
  const before = (await library()).projects.filter((p) => !p.trashedAt).map((p) => p.name).sort();
  await home();
  errors.length && allErrors.push(...errors);
  await app.close();
  ({ app, page, errors } = await launch(dir));
  const after = (await library()).projects.filter((p) => !p.trashedAt).map((p) => p.name).sort();
  check(JSON.stringify(before) === JSON.stringify(after), 'projects are all there after restarting the app');
  check((await page.$$('.recent')).length > 0, 'Recents is filled in after restarting');
  check((await page.textContent('.page-head h1')).length > 0 && !!(await page.$('.project-card')), 'with projects, the app opens on them');
  await page.click('.recent >> nth=0');
  await page.waitForSelector('.editor');
  await sleep(500);
  check(true, 'a project reopens after restarting');

  // Closing the window straight after an edit, inside the autosave delay, must not lose it.
  await page.click('.rail-item:has-text("Text")');
  await page.click('button:has-text("Add a heading")');
  await page.fill('.inspector textarea', 'Written just before closing');
  const name = await page.inputValue('.project-name');
  allErrors.push(...errors);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  if (process.platform === 'darwin') {
    // Closing the last window leaves a Mac app running, so it has to be quit as well.
    await page.waitForEvent('close', { timeout: 10000 }).catch(() => undefined);
    await app.close().catch(() => undefined);
  } else {
    await app.waitForEvent('close', { timeout: 10000 }).catch(() => undefined);
  }
  ({ app, page, errors } = await launch(dir));
  const meta = (await library()).projects.find((p) => p.name === name);
  const doc = await page.evaluate((id) => window.api.library.loadProject(id), meta.id);
  check(doc.items.some((i) => i.text === 'Written just before closing'), 'an edit made just before closing is saved');
});

section('phone', async () => {
  await newProject();
  await page.click('.rail-item:has-text("Media")');
  await page.evaluate(() => undefined);
  await home();
  await page.click('.sidebar .nav-item:has-text("Edit my footage")');
  await page.waitForSelector('.modal');
  await page.click('.welcome-option:has-text("Add from phone")');
  await page.waitForSelector('.qr svg', { timeout: 8000 });
  await sleep(150);
  await shot(page, '24-phone');
  const url = (await page.textContent('.qr-url')).trim();
  check(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/[0-9a-f]{32}$/.test(url), 'the phone page has a private address', url);
  const html = await (await fetch(url)).text();
  check(html.includes('Choose files'), 'the phone page is served');
  const wrong = await fetch(url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)));
  check(wrong.status === 404, 'a wrong address gets nothing');
  const body = readFileSync(media('portrait.mp4'));
  const sent = await (await fetch(`${url}/upload?name=${encodeURIComponent('from phone.mp4')}`, { method: 'PUT', body })).json();
  check(sent.ok === true, 'a phone can upload a file', JSON.stringify(sent));
  await page.waitForSelector('.clip.video', { timeout: 8000 });
  check((await page.textContent('.modal')).includes('from phone.mp4'), 'received files are listed');
  await page.click('.modal-foot button:has-text("Done")');
  await sleep(300);
  const gone = await fetch(url).then(() => false, () => true);
  check(gone, 'the address stops working when the dialog closes');
});

section('recorder', async () => {
  // A small window of our own to record, so the test never captures anything else on the desktop.
  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ width: 640, height: 400, show: true, title: 'Capture target' });
    void w.loadURL('data:text/html,<title>Capture target</title><body style="margin:0;background:%2300c060"></body>');
    globalThis.captureTarget = w;
  });
  await sleep(800);
  await newProject();
  await page.click('button:has-text("Record") >> nth=0');
  await page.waitForSelector('.modal');
  await page.waitForSelector('.source', { timeout: 10000 });
  await page.click('.segmented button:has-text("Window")');
  await page.waitForSelector('.source:has-text("Capture target")', { timeout: 8000 });
  await page.click('.source:has-text("Capture target")');
  const sw = page.locator('[aria-label="Record microphone"]');
  if ((await sw.count()) && (await sw.getAttribute('aria-checked')) === 'true') await sw.click();
  await page.click('.modal-foot button:has-text("Start recording")');
  await page.waitForSelector('.rec-indicator', { timeout: 12000 });
  check(true, 'recording starts after the countdown');
  await sleep(2500);
  await page.click('button:has-text("Stop recording")');
  await page.waitForSelector('.clip.video', { timeout: 15000 });
  await app.evaluate(() => globalThis.captureTarget?.destroy());
  await sleep(400);
  const lib = await library();
  const rec = lib.assets.find((a) => a.source === 'recording');
  check(!!rec && rec.kind === 'video', 'the recording lands on the timeline as video');
  check(rec.duration > 1.5 && rec.duration < 6, 'the recording has a real duration', String(rec?.duration));
  check(rec.width > 200, 'the recording has the size of the window', `${rec?.width}x${rec?.height}`);
  await sleep(500);
  const hasPicture = await page.$eval('.stage video', (v) => v.videoWidth > 0);
  check(hasPicture, 'the recording plays in the editor');

  // Starting from the left menu, Record ends in a new project with the recording in it.
  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ width: 640, height: 400, show: true, title: 'Capture target' });
    void w.loadURL('data:text/html,<title>Capture target</title><body style="margin:0;background:%2300c060"></body>');
    globalThis.captureTarget = w;
  });
  await sleep(800);
  await home();
  const before = (await library()).projects.length;
  await page.click('.sidebar .nav-item:has-text("Record")');
  await page.waitForSelector('.source', { timeout: 10000 });
  await page.click('.segmented button:has-text("Window")');
  await page.waitForSelector('.source:has-text("Capture target")', { timeout: 8000 });
  await page.click('.source:has-text("Capture target")');
  const sw2 = page.locator('[aria-label="Record microphone"]');
  if ((await sw2.count()) && (await sw2.getAttribute('aria-checked')) === 'true') await sw2.click();
  await page.click('.modal-foot button:has-text("Start recording")');
  await page.waitForSelector('.rec-indicator', { timeout: 12000 });
  await sleep(1500);
  await page.click('button:has-text("Stop recording")');
  await page.waitForSelector('.editor .clip.video', { timeout: 15000 });
  await app.evaluate(() => globalThis.captureTarget?.destroy());
  check((await library()).projects.length === before + 1, 'recording from the left menu opens a new project with the footage in place');
  const recordings = (await library()).assets.filter((a) => a.source === 'recording');
  check(recordings.length === 2 && recordings.every((a) => a.scope === 'workspace'), 'recordings are kept in Media wherever Record was pressed', String(recordings.length));
});

section('script', async () => {
  await home();
  await page.click('.sidebar .nav-item:has-text("Video from a script")');
  await page.click('[role="tab"]:has-text("Script")');
  const pills = await page.$$eval('.pill', (e) => e.map((p) => p.textContent));
  check(pills.length >= 4 && pills.length <= 6, 'the main script settings are shown, the rest on request', pills.join(', '));
  await page.click('.pill:has-text("More options")');
  check((await page.$$('.pill')).length >= 6, 'More options shows the rest');
  await page.click('.pill:has-text("Fewer options")');
  await page.fill('.prompt-input', 'Welcome to the first test of this feature. It turns text into a video!\n\nEach sentence becomes a subtitle, timed to the voice.');
  await sleep(100);
  await shot(page, '25-script');
  await page.click('button:has-text("Generate video")');
  await page.waitForSelector('.video-page', { timeout: 60000 });
  await page.waitForSelector('.video-player', { timeout: 120000 });
  await sleep(300);
  await shot(page, '26-script-video');
  const lib = await library();
  const meta = lib.projects.find((p) => p.scriptOrigin);
  check(!!meta?.lastExport, 'a script becomes an exported video');
  const file = join(dir, 'library', 'exports', meta.id, meta.lastExport.file);
  const info = probe(file);
  check(info.streams.some((s) => s.codec_type === 'audio'), 'the video has narration');
  check(Number(info.format.duration) > 3, 'the video lasts as long as the voice', info.format.duration);
  const v = info.streams.find((s) => s.codec_type === 'video');
  check(v.height > v.width, 'the chosen portrait shape is used', `${v.width}x${v.height}`);
  check(await page.isVisible('button:has-text("Reuse script")'), 'a variant can be started from the finished video');
  await page.click('button:has-text("Reuse script")');
  await page.waitForSelector('.prompt-input');
  check((await page.inputValue('.prompt-input')).startsWith('Welcome to the first'), 'Reuse script fills the box again');
  await page.click('.sidebar .nav-item:has-text("Projects")');
  await page.waitForSelector('.project-card');
  await page.click(`.project-card:has-text("${meta.name.slice(0, 18)}") .project-thumb`);
  await page.waitForSelector('.clip.text', { timeout: 10000 });
  check((await page.$$('.clip.text')).length >= 3, 'the generated video opens in the editor with its subtitles');
  await shot(page, '27-script-editor');
  await home();

  // A topic needs a key; without one the message says so instead of failing silently.
  await page.click('.sidebar .nav-item:has-text("Video from a script")');
  await page.click('[role="tab"]:has-text("Topic")');
  await page.fill('.prompt-input', 'Why teams should write things down');
  await page.click('button:has-text("Write script")');
  await page.waitForSelector('.notice.error', { timeout: 30000 });
  const text = await page.textContent('.notice.error');
  check(/API key/.test(text), 'drafting without a key explains what to do', text);
});

section('brand', async () => {
  await home();
  await page.click('.sidebar .nav-item:has-text("Brand")');
  await page.click('button:has-text("New brand kit") >> nth=0');
  await page.fill('.modal input', 'Acme');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.kit-editor');
  await stubOpenDialog(app, [media('logo.png')]);
  await page.locator('.kit-editor button:has-text("Add")').first().click();
  await page.waitForSelector('.kit-logo img', { timeout: 8000 });
  await page.fill('.kit-editor input[type=color]', '#ff6600');
  await page.click('button:has-text("Add colour")');
  await page.waitForSelector('.kit-editor .swatch');
  await shot(page, '28-brand');
  await newProject();
  await page.click('.rail-item:has-text("Brand")');
  await page.click('.panel .swatch');
  await sleep(200);
  check((await storedDoc()).settings.background === '#ff6600', 'a brand colour applies to the canvas');
  await page.click('.panel .asset-tile');
  await sleep(400);
  check((await clips(page)).some((c) => c.type === 'image'), 'a brand logo goes on the canvas');
});

section('tools', async () => {
  // Text to speech inside a project
  await newProject([media('clip-a.mp4')]);
  await page.click('.rail-item:has-text("Audio")');
  await page.click('.panel button:has-text("Text to speech")');
  await page.waitForSelector('.modal textarea');
  await page.fill('.modal textarea', 'Hello there. This line was spoken by the computer.');
  await page.click('.modal-foot button:has-text("Add voice-over")');
  await page.waitForSelector('.clip.audio', { timeout: 30000 });
  await page.waitForSelector('.clip.text', { timeout: 5000 });
  check((await page.$$('.clip.text')).length >= 2, 'text to speech adds a voice-over and matching subtitles');
  await page.waitForSelector('.modal:has-text("Mute the sound underneath?")', { timeout: 5000 });
  check(true, 'a voice-over over footage asks about the sound underneath');
  await page.click('.modal-foot button:has-text("Mute the video")');
  await sleep(150);
  check((await storedDoc()).items.find((i) => i.type === 'video').muted, 'and mutes it on request');
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);

  // Speed
  let list = await clips(page);
  const video = list.find((c) => c.type === 'video');
  let b = await box(clipSel(video.id));
  await page.mouse.click(b.x + 40, b.y + 25);
  await page.waitForSelector('.inspector >> text=Speed');
  await page.click('.segmented button:has-text("2x")');
  await sleep(150);
  let doc = await storedDoc();
  let v = doc.items.find((i) => i.type === 'video');
  check(v.speed === 2 && Math.abs(v.duration - 3) < 0.05, 'doubling the speed halves the clip', JSON.stringify({ s: v.speed, d: v.duration }));
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);

  // Replace media
  b = await box(clipSel(video.id));
  await stubOpenDialog(app, [media('clip-b.mp4')]);
  await page.mouse.click(b.x + 40, b.y + 25, { button: 'right' });
  await page.click('.menu-item:has-text("Replace media")');
  await page.waitForSelector('.modal:has-text("Replace media")');
  check(true, 'Replace media offers what is in Media first');
  await page.click('.modal button:has-text("Add from your computer")');
  await page.waitForFunction(() => document.querySelector('.clip.video')?.textContent.includes('clip-b.mp4'), null, { timeout: 8000 });
  doc = await storedDoc();
  v = doc.items.find((i) => i.type === 'video');
  check(v.start === 0 && v.duration <= 4.05, 'replacing media keeps the clip in place and fits the new length', JSON.stringify({ d: v.duration }));
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);

  // Dragging from the panel onto the timeline
  await page.click('.rail-item:has-text("Media")');
  const n = (await clips(page)).length;
  await page.locator('.asset-tile:has-text("clip-b.mp4")').first().dragTo(page.locator('.tl-rows'), { targetPosition: { x: 900, y: 8 } });
  await sleep(300);
  check((await clips(page)).length === n + 1, 'an asset can be dragged onto the timeline', `${n} -> ${(await clips(page)).length}`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(150);

  // An image as the background sits under everything and fills the frame
  await page.click('.editor-top [aria-label="Project settings"]');
  await stubOpenDialog(app, [media('wide.jpeg')]);
  await page.click('.modal button:has-text("Use an image")');
  await page.waitForSelector('.clip.image', { timeout: 8000 });
  await sleep(200);
  doc = await storedDoc();
  const backdrop = doc.items.find((i) => i.type === 'image');
  check(backdrop.trackId === doc.tracks.at(-1).id, 'a background image goes on the bottom layer');
  check(backdrop.w >= doc.settings.width - 1 && backdrop.h >= doc.settings.height - 1, 'a background image fills the frame', JSON.stringify([backdrop.w, backdrop.h]));
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(200);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await sleep(200);
  check((await storedDoc()).items.some((i) => i.type === 'image'), 'redo brings changes back');
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await sleep(200);

  // Cancelling an export
  await page.click('.editor-top button:has-text("Export")');
  await page.selectOption('.modal select[aria-label="Export quality"]', '4k');
  await page.click('.modal-foot button:has-text("Export")');
  await page.waitForSelector('.render-card', { timeout: 10000 });
  await shot(page, '34-rendering');
  await page.click('.render-card button:has-text("Cancel")');
  await page.waitForSelector('text=The export was cancelled', { timeout: 15000 });
  check(true, 'an export can be cancelled');
  await sleep(600);
  const leftovers = await page.evaluate(async () => (await window.api.render.current()) === null);
  check(leftovers, 'nothing keeps rendering after cancelling');
  await page.click('button:has-text("Open in editor")');
  await page.waitForSelector('.clip');
  await page.click('.editor-top [aria-label="Project settings"]');

  // Fixed duration
  await page.click('.segmented button:has-text("Fixed")');
  await page.fill('[aria-label="Project length"]', '2');
  await page.keyboard.press('Tab');
  await sleep(150);
  await page.click('.modal-foot button:has-text("Done")');
  check(!!(await page.$('.tl-project-end')), 'a fixed length is marked on the timeline');
  await page.click('.editor-top button:has-text("Export")');
  await page.selectOption('.modal select[aria-label="Export quality"]', 'draft');
  await page.click('.modal-foot button:has-text("Export")');
  await page.waitForSelector('.video-player', { timeout: 60000 });
  const lib = await library();
  const meta = lib.projects.sort((x, y) => y.updatedAt - x.updatedAt).find((p) => p.lastExport);
  const file = join(dir, 'library', 'exports', meta.id, meta.lastExport.file);
  check(Math.abs(Number(probe(file).format.duration) - 2) < 0.1, 'a fixed length decides the length of the export', probe(file).format.duration);

  // A copy in a new shape
  await page.click('.sidebar .nav-item:has-text("Projects")');
  await page.waitForSelector('.project-card');
  const card = page.locator('.project-card', { hasText: meta.name }).first();
  await card.hover();
  await card.locator('[aria-label^="More options"]').click();
  await page.click('.menu-item:has-text("Copy in a new shape")');
  await page.selectOption('.modal select', '9:16');
  await page.click('.modal-foot button:has-text("Create copy")');
  await page.waitForSelector('.editor');
  await page.waitForSelector('.clip');
  await sleep(300);
  doc = await storedDoc();
  check(doc.settings.height > doc.settings.width, 'Copy in a new shape makes a copy in the new shape', `${doc.settings.width}x${doc.settings.height}`);
  v = doc.items.find((i) => i.type === 'video');
  check(v.h >= doc.settings.height - 1, 'footage fills the new frame', JSON.stringify({ w: v.w, h: v.h }));
  await shot(page, '31-resized');
  await home();

  // Key storage: Claude's key lives with the other AI keys.
  await page.click('.sidebar .nav-item:has-text("Settings")');
  await page.waitForSelector('.modal');
  await shot(page, '32-settings');
  check(!(await page.$('[aria-label="Anthropic API key"]')), 'Settings holds no AI keys of its own');
  await page.click('.modal button:has-text("AI connections")');
  await page.fill('[aria-label="Anthropic API key"]', 'sk-ant-e2e-placeholder-value');
  await page.click('[data-provider="claude"] button:has-text("Connect")');
  await page.waitForSelector('[data-provider="claude"] .badge:has-text("Connected")');
  const keyFile = join(dir, 'anthropic.key');
  check(existsSync(keyFile), 'the API key is stored');
  check(!readFileSync(keyFile).includes('sk-ant-e2e'), 'the stored key is encrypted');
  check(!JSON.stringify(await library()).includes('sk-ant-e2e'), 'the key never reaches the page');
  await page.click('[data-provider="claude"] button:has-text("Disconnect")');
  await page.waitForFunction(() => !document.querySelector('[data-provider="claude"] .badge'));
  check(!existsSync(keyFile), 'the key can be removed');
  await page.click('.modal-foot button:has-text("Done")');
});

section('rotation', async () => {
  // A phone photo stored sideways with an EXIF tag: red is on the left of the pixels, and on top when displayed.
  await newProject([media('exif-rotated.jpg')]);
  const lib = await library();
  const photo = lib.assets.find((a) => a.name === 'exif-rotated.jpg');
  check(photo.width === 300 && photo.height === 400, 'EXIF rotation is honoured on import', `${photo.width}x${photo.height}`);
  check(photo.raster === 'ready', 'export uses the upright picture');
  const doc = await storedDoc();
  check(doc.settings.height > doc.settings.width, 'the canvas takes the upright shape', `${doc.settings.width}x${doc.settings.height}`);
  await exportVideo(page);
  await page.waitForSelector('.video-player', { timeout: 60000 });
  const meta = (await library()).projects.find((p) => p.assetIds.includes(photo.id));
  const file = join(dir, 'library', 'exports', meta.id, meta.lastExport.file);
  const v = probe(file).streams.find((s) => s.codec_type === 'video');
  check(close(pixel(file, 1, v.width / 2, v.height * 0.2), [255, 0, 0], 50), 'the top of the export is red', String(pixel(file, 1, v.width / 2, v.height * 0.2)));
  check(close(pixel(file, 1, v.width / 2, v.height * 0.8), [0, 0, 255], 50), 'the bottom of the export is blue', String(pixel(file, 1, v.width / 2, v.height * 0.8)));

  await newProject([media('rotated.mp4')]);
  const d2 = await storedDoc();
  check(d2.settings.height > d2.settings.width, 'a video with rotation metadata gets a portrait canvas', `${d2.settings.width}x${d2.settings.height}`);
  await sleep(600);
  const size = await page.$eval('.stage video', (e) => [e.videoWidth, e.videoHeight]);
  check(size[1] > size[0], 'the preview agrees with the export about which way up it is', String(size));
});

section('themes', async () => {
  await page.evaluate(() => window.api.library.updateSettings({ theme: 'dark' }));
  await sleep(200);
  check((await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'dark', 'the theme setting reaches the operating system layer');
  await page.emulateMedia({ colorScheme: 'dark' });
  await newProject([media('clip-a.mp4'), media('tone.mp3')]);
  await sleep(900);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === 'rgb(14, 16, 20)', 'dark colours apply', bg);
  await shot(page, '29-dark-editor');
  await home();
  await page.click('.sidebar .nav-item:has-text("Projects")');
  await page.waitForSelector('.project-card');
  await sleep(200);
  await shot(page, '30-dark-library');
  await page.evaluate(() => window.api.library.updateSettings({ theme: 'system' }));
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(200);
});

section('update', async () => {
  // Test runs never check GitHub, so these stand in for what the updater reports.
  const emit = (event, payload) => app.evaluate(({ BrowserWindow }, [e, p]) => BrowserWindow.getAllWindows()[0].webContents.send(e, p), [event, payload]);
  const button = (text) => `.update-banner button:has-text("${text}")`;
  await home();
  check(!(await page.$('.update-banner')), 'no update notice until a new version is found');

  await emit('update:changed', { kind: 'available', version: '9.9.9' });
  await page.waitForSelector('.update-banner');
  check((await page.textContent('.update-banner')).includes('9.9.9 is available'), 'a Mac is told a new version is out');
  check(await page.isVisible(button('Download')), 'with a way to download it');
  await shot(page, '31-update-available');
  await page.click(button('Later'));
  await sleep(100);
  check(!(await page.$('.update-banner')), 'Later puts the notice away');
  await emit('update:changed', { kind: 'available', version: '9.9.9' });
  await sleep(100);
  check(!(await page.$('.update-banner')), 'and it stays away for that version');

  await emit('update:changed', { kind: 'ready', version: '9.9.10' });
  await page.waitForSelector('.update-banner');
  check((await page.textContent('.update-banner')).includes('9.9.10 is ready to install'), 'a newer version shows again, ready to install');
  check(await page.isEnabled(button('Restart now')), 'with a restart button');
  await shot(page, '32-update-ready');

  const render = { jobId: 'e2e-update', projectId: 'none', kind: 'section', progress: 0.5 };
  await emit('render:progress', { ...render, state: 'rendering' });
  await sleep(100);
  check(await page.isDisabled(button('Restart now')), 'restarting waits for an export to finish');
  await emit('render:progress', { ...render, state: 'cancelled' });
  await sleep(100);
  check(await page.isEnabled(button('Restart now')), 'and is possible again afterwards');
  await page.click(button('Later'));

  // The notice reaches people in the editor too, and restarting from there keeps their work.
  await newProject([media('clip-a.mp4'), media('logo.png')]);
  await emit('update:changed', { kind: 'ready', version: '9.9.11' });
  await page.waitForSelector('.update-banner');
  const [banner, editor] = [await box('.update-banner'), await box('.editor')];
  const windowHeight = await page.evaluate(() => window.innerHeight);
  check(editor.y >= banner.y + banner.height - 1 && editor.y + editor.height <= windowHeight + 1, 'the notice shows in the editor, which makes room for it', JSON.stringify({ banner, editor, windowHeight }));
  await shot(page, '33-update-editor');
  const before = await storedDoc();
  await page.click('.clip.image');
  await page.keyboard.press('Delete');
  await page.click(button('Restart now'));
  await sleep(400); // Sooner than the 800 ms autosave would have written it.
  const after = await page.evaluate((id) => window.api.library.loadProject(id), before.id);
  check(after.items.length === before.items.length - 1, 'Restart now saves the open project first', `${before.items.length} then ${after.items.length}`);
  await page.click(button('Later'));
  await home();
});

section('ai', async () => {
  // A separate run of the app, pointed at the stand-in for the AI services.
  const fake = await new FakeProviders().start();
  const second = newDataDir();
  const inst = await launch(second, { VIEWEDITOR_AI_HOSTS: fake.hosts, VIEWEDITOR_AI_POLL_MS: '60' });
  const p = inst.page;
  const a = inst.app;
  const lib = () => p.evaluate(() => window.api.library.get());
  const wait = (ms) => p.waitForTimeout(ms);
  const pclips = () => clips(p);
  const stored = async () => {
    await p.waitForSelector('.save-state:has-text("Saved")', { timeout: 8000 });
    const l = await lib();
    const name = await p.inputValue('.project-name');
    return p.evaluate((id) => window.api.library.loadProject(id), l.projects.find((x) => x.name === name && !x.trashedAt).id);
  };
  const toHome = async () => {
    if (await p.$('.editor')) await p.click('[aria-label="Back to Projects"]');
    await p.waitForSelector('.sidebar');
  };
  const blank = async (files) => {
    await toHome();
    await p.click('.sidebar .nav-item:has-text("Edit my footage")');
    await p.waitForSelector('.modal');
    if (files) {
      await stubOpenDialog(a, files);
      await p.click('.modal .dropzone');
      await p.waitForFunction((n) => document.querySelectorAll('.clip').length >= n, files.length, { timeout: 15000 });
      await wait(300);
    } else {
      await p.click('.modal button:has-text("Start with an empty project")');
      await p.waitForSelector('.editor .tl-add-media');
    }
  };
  const selectClip = async (id) => {
    const b = await p.locator(`.clip[data-clip="${id}"]`).boundingBox();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await wait(120);
  };

  try {
    // Choosing AI scenes with nothing connected goes through connecting, and the choice is not lost.
    await p.click('.sidebar .nav-item:has-text("Video from a script")');
    await p.click('.pill:has-text("Colour background")');
    await p.click('.menu-item:has-text("AI scenes")');
    await p.waitForSelector('.provider-card');
    await p.click('.modal-foot button:has-text("Done")');
    await wait(100);
    check(await p.isVisible('.pill:has-text("Colour background")'), 'leaving without connecting changes nothing');
    await p.click('.pill:has-text("Colour background")');
    await p.click('.menu-item:has-text("AI scenes")');
    await p.fill('[aria-label="Runway API key"]', KEYS.runway);
    await p.click('[data-provider="runway"] button:has-text("Connect")');
    await p.waitForSelector('[data-provider="runway"] .badge:has-text("Connected")');
    await p.click('.modal-foot button:has-text("Done")');
    await p.waitForSelector('.pill:has-text("AI scenes")', { timeout: 3000 });
    check(true, 'AI scenes is applied once a service is connected');
    await p.click('.sidebar .nav-item:has-text("AI connections")');
    await p.click('[data-provider="runway"] button:has-text("Disconnect")');
    await p.waitForSelector('[aria-label="Runway API key"]');
    await p.click('.modal-foot button:has-text("Done")');

    // Not connected yet
    await blank();
    await p.click('.rail-item:has-text("AI tools")');
    check(await p.isVisible('.panel button:has-text("Connect an AI service")'), 'the AI panel invites connecting a service first');
    await shot(p, '40-ai-not-connected');

    // Connecting
    await p.click('.panel button:has-text("Connect an AI service")');
    await p.waitForSelector('.provider-card');
    check((await p.$$('.provider-card')).length === 4, 'three video services and Claude can be connected');
    await p.fill('[aria-label="fal.ai API key"]', 'wrong-key');
    await p.click('[data-provider="fal"] button:has-text("Connect")');
    await p.waitForSelector('[data-provider="fal"] .notice.error');
    check((await p.textContent('[data-provider="fal"] .notice.error')).includes('did not accept'), 'a bad key is rejected with a clear message');
    check(!existsSync(join(second, 'ai-keys.json')) || !readFileSync(join(second, 'ai-keys.json'), 'utf8').includes('wrong-key'), 'a bad key is not stored');
    await p.fill('[aria-label="fal.ai API key"]', KEYS.fal);
    await p.click('[data-provider="fal"] button:has-text("Connect")');
    await p.waitForSelector('[data-provider="fal"] .badge:has-text("Connected")');
    await p.fill('[aria-label="Runway API key"]', KEYS.runway);
    await p.click('[data-provider="runway"] button:has-text("Connect")');
    await p.waitForSelector('[data-provider="runway"] .badge:has-text("Connected")');
    check((await p.textContent('[data-provider="runway"]')).includes('12,500 credits'), 'Runway shows the credit balance');
    await shot(p, '41-ai-connections');
    const keyFile = readFileSync(join(second, 'ai-keys.json'), 'utf8');
    check(!keyFile.includes(KEYS.fal) && !keyFile.includes(KEYS.runway), 'keys are encrypted on disk');
    check(!JSON.stringify(await lib()).includes(KEYS.fal), 'keys never reach the page');
    await p.click('.modal-foot button:has-text("Done")');

    // The form follows the model
    await p.waitForSelector('.ai-form select[aria-label="Model"]', { timeout: 15000 });
    const options = await p.$$eval('.ai-form select[aria-label="Model"] option', (e) => e.map((o) => ({ value: o.value, text: o.textContent })));
    check(options.length >= 20, 'models from both services are listed', String(options.length));
    const veo = options.find((o) => o.value === 'runway:text-to-video:veo3.1');
    const gen = options.find((o) => o.value === 'runway:text-to-video:gen4.5');
    check(!!veo && !!gen, 'models are read from the published spec');
    await p.selectOption('.ai-form select[aria-label="Model"]', veo.value);
    await wait(150);
    const veoLengths = await p.$$eval('.ai-form select[aria-label="Length"] option', (e) => e.map((o) => o.textContent));
    check(JSON.stringify(veoLengths.filter((l) => !l.includes('trimmed'))) === JSON.stringify(['4 s', '6 s', '8 s']), 'Veo offers exactly its lengths', veoLengths.join());
    check(veoLengths.includes('3 s · trimmed from 4 s'), 'and shorter ones are made longer and trimmed', veoLengths.join());
    await p.selectOption('.ai-form select[aria-label="Model"]', gen.value);
    await wait(150);
    const genLengths = await p.$$eval('.ai-form select[aria-label="Length"] option', (e) => e.map((o) => o.textContent));
    check(genLengths.includes('10 s') && genLengths.length > 3, 'another model offers its own lengths', genLengths.join());
    const falModel = options.find((o) => o.value === 'fal:text-to-video:minimax/h3-max/text-to-video');
    await p.selectOption('.ai-form select[aria-label="Model"]', falModel.value);
    await p.waitForSelector('.ai-form >> text=$0.15 per second');
    check(true, 'the price is shown before generating');
    check(/about \$\d+\.\d\d for this clip/.test(await p.textContent('.ai-form')), 'and what this clip comes to', await p.textContent('.ai-form'));
    const groupsOffered = await p.$$eval('.ai-form select[aria-label="Model"] optgroup', (e) => e.map((g) => g.label));
    check(groupsOffered[0] === 'Recommended', 'a short recommended list comes first', groupsOffered.join());
    check(await p.isDisabled('.ai-form button:has-text("Generate")'), 'nothing can start without a prompt');

    // Generating into a project
    await p.fill('.ai-form textarea', 'A paper boat on a stream');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForSelector('.ai-job', { timeout: 5000 });
    await shot(p, '42-ai-generating');
    await p.waitForSelector('.clip.video', { timeout: 15000 });
    await wait(300);
    let list = await pclips();
    check(list.length === 1 && list[0].type === 'video', 'the generated clip lands on the timeline');
    let doc = await stored();
    check(doc.settings.width === 1920, 'the canvas takes the size of the generated clip', String(doc.settings.width));
    const sent = fake.callsTo('/fal-queue/minimax/h3-max/text-to-video', 'POST').at(-1);
    check(sent.body.prompt === 'A paper boat on a stream' && sent.headers.authorization === `Key ${KEYS.fal}`, 'the request carries the prompt and the key');
    await shot(p, '43-ai-clip-on-timeline');
    await p.waitForSelector('.ai-job[data-job-state="done"]');
    check(true, 'the job shows as finished');

    // It is an ordinary clip: trim it
    const first = list[0];
    await selectClip(first.id);
    check((await p.textContent('.inspector')).includes('A paper boat on a stream'), 'a generated clip remembers its prompt');
    await p.keyboard.press('Home');
    await wait(100);

    // Looking at a clip leaves the left side alone, and looking elsewhere does not cost what was typed.
    await p.waitForSelector('.ai-form textarea');
    await p.fill('.ai-form textarea', 'Still here after looking at a clip');
    const shortest = await p.$eval('.ai-form select[aria-label="Length"] option', (o) => o.value);
    await p.selectOption('.ai-form select[aria-label="Length"]', shortest);
    await p.keyboard.press('Escape');
    await selectClip(first.id);
    check(await p.isVisible('.panel .ai-form textarea'), 'clicking a clip leaves the left panel as it was');
    check(await p.isVisible('.inspector >> text=Speed'), 'its settings open on the right');
    await p.click('.rail-item:has-text("Text")');
    await p.click('.rail-item:has-text("AI tools")');
    await p.waitForSelector('.ai-form textarea');
    await wait(150);
    check((await p.inputValue('.ai-form textarea')) === 'Still here after looking at a clip', 'the AI form keeps its prompt when you go elsewhere and back');
    check((await p.inputValue('.ai-form select[aria-label="Length"]')) === shortest, 'and its length');
    await p.fill('.ai-form textarea', '');
    await selectClip(first.id);

    // Edit with AI
    await p.click('.inspector button:has-text("Edit with AI")');
    await p.waitForSelector('.panel .ai-form select[aria-label="Model"]');
    check(!(await p.$('.modal')) && !(await p.$('.panel select[aria-label="What to generate"]')), 'a clip action opens in the AI panel, with the clip filled in');
    const editModels = await p.$$eval('.panel select[aria-label="Model"] option', (e) => e.map((o) => o.value));
    check(editModels.includes('runway:edit-video:aleph2'), 'video editing models are offered');
    await p.selectOption('.panel select[aria-label="Model"]', 'runway:edit-video:aleph2');
    await wait(100);
    await shot(p, '44-ai-edit-panel');
    const before = (await stored()).items[0];
    fake.pollsToFinish = 6;
    await p.fill('.panel .ai-form textarea', 'Make it golden hour');
    await p.click('.panel button:has-text("Edit this clip")');
    await p.waitForSelector('.panel select[aria-label="What to generate"]');
    await p.waitForSelector('.clip-busy', { timeout: 5000 });
    check(true, 'the clip shows that AI is working on it');
    fake.pollsToFinish = 2;
    await p.waitForFunction(() => !document.querySelector('.clip-busy'), null, { timeout: 15000 });
    await wait(300);
    doc = await stored();
    check(doc.items.length === 1 && doc.items[0].assetId !== before.assetId, 'the result replaces the clip in place', JSON.stringify(doc.items.map((i) => i.assetId)));
    check(fake.callsTo('/runway/v1/video_to_video', 'POST').at(-1).body.promptText === 'Make it golden hour', 'the edit went to the chosen service');
    check(fake.uploads.length >= 1, 'the clip was uploaded for editing');
    await p.keyboard.press(`${MOD}+z`);
    await wait(200);
    doc = await stored();
    check(doc.items[0].assetId === before.assetId, 'undo brings the original clip back');
    await p.keyboard.press(`${MOD}+Shift+z`);
    await wait(200);
    await selectClip(first.id);
    await p.click('.inspector button:has-text("Restore original")');
    await wait(200);
    doc = await stored();
    check(doc.items[0].assetId === before.assetId, 'Restore original brings it back, even after leaving the editor');
    await p.keyboard.press(`${MOD}+z`);
    await wait(200);

    // Extend with AI
    await selectClip(first.id);
    await p.click('.inspector button:has-text("Extend with AI")');
    await p.waitForSelector('.panel button:has-text("Extend this clip")');
    await p.selectOption('.panel select[aria-label="Model"]', 'fal:image-to-video:kling/v4/image-to-video');
    await wait(100);
    await p.fill('.panel .ai-form textarea', 'The boat drifts on');
    fake.pollsToFinish = 6;
    await p.click('.panel button:has-text("Extend this clip")');
    await p.waitForSelector('.tl-pending', { timeout: 5000 });
    check(true, 'the timeline shows where the new shot will land');
    await shot(p, '45-ai-pending');
    fake.pollsToFinish = 2;
    await p.waitForFunction(() => document.querySelectorAll('.clip.video').length === 2, null, { timeout: 15000 });
    await wait(300);
    doc = await stored();
    const ordered = doc.items.slice().sort((x, y) => x.start - y.start);
    check(Math.abs(ordered[1].start - (ordered[0].start + ordered[0].duration)) < 0.05 && ordered[1].trackId === ordered[0].trackId, 'the extension goes straight after the clip');

    // Animating an image
    await blank([media('photo.jpg')]);
    list = await pclips();
    await selectClip(list[0].id);
    await p.click('.inspector button:has-text("Animate with AI")');
    await p.waitForSelector('.panel button:has-text("Animate this image")');
    await p.selectOption('.panel select[aria-label="Model"]', 'fal:image-to-video:kling/v4/image-to-video');
    await wait(100);
    await p.fill('.panel .ai-form textarea', 'A slow push in');
    await p.click('.panel button:has-text("Animate this image")');
    await p.waitForSelector('.clip.video', { timeout: 15000 });
    await wait(300);
    check((await pclips()).length === 1, 'the animation replaces the image');

    // Over footage, a generated clip goes at the playhead on a row of its own, and says where it went.
    await blank([media('clip-a.mp4')]);
    await p.click('.rail-item:has-text("AI tools")');
    await p.waitForSelector('.ai-form textarea');
    await p.keyboard.press('Home');
    await p.keyboard.press('Shift+ArrowRight');
    await p.keyboard.press('Shift+ArrowRight');
    await p.fill('.ai-form textarea', 'Goes over the footage');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForFunction(() => document.querySelectorAll('.clip.video').length === 2, null, { timeout: 15000 });
    await wait(300);
    doc = await stored();
    const overClip = doc.items.find((i) => i.trackId === doc.tracks[0].id);
    check(doc.tracks.length === 2 && Math.abs(overClip.start - 2) < 0.1, 'over footage, the clip goes at the playhead on its own row', JSON.stringify(doc.items.map((i) => i.start)));
    check((await pclips()).find((c) => c.id === overClip.id).selected, 'and it is selected');
    check(!!(await p.$('.toast:has-text("on the timeline at 0:02")')), 'and the message says where it went', await p.textContent('.toasts').catch(() => ''));
    await p.selectOption('.ai-form select[aria-label="Where to place the result"]', 'end');
    await p.fill('.ai-form textarea', 'Goes after the last clip');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForFunction(() => document.querySelectorAll('.clip.video').length === 3, null, { timeout: 15000 });
    await wait(300);
    doc = await stored();
    const ends = doc.items.filter((i) => i.type === 'video').sort((x, y) => x.start - y.start);
    check(Math.abs(ends[2].start - (ends[1].start + ends[1].duration)) < 0.1, 'After the last clip builds a sequence instead', JSON.stringify(ends.map((i) => i.start)));

    // A recording can be the sound for a talking photo.
    await p.selectOption('select[aria-label="What to generate"]', 'talking-photo');
    await p.waitForSelector('.ai-form select[aria-label="Audio"]');
    const soundOptions = await p.$$eval('.ai-form select[aria-label="Audio"] option', (e) => e.map((o) => o.textContent));
    check(soundOptions.includes('clip-a.mp4'), 'audio lists offer videos with sound', soundOptions.join());
    await p.selectOption('.ai-form select[aria-label="Audio"]', { label: 'clip-a.mp4' });
    await p.waitForSelector('.ai-form [aria-label="Use the sound from"]');
    check(true, 'and the stretch to use can be set');
    await p.selectOption('select[aria-label="What to generate"]', 'lip-sync');
    await p.waitForSelector('.panel .notice, .panel .ai-form');
    check(true, 'lip-sync is in the AI panel with the other tools');
    await p.selectOption('select[aria-label="What to generate"]', 'text-to-video');

    // Starting from the sound: a clip of sound offers a picture to go with it.
    await blank([media('tone.mp3')]);
    const toneClip = (await pclips())[0];
    await selectClip(toneClip.id);
    await p.click('.inspector button:has-text("Generate a picture for this")');
    await p.waitForSelector('.ai-form .sound-window');
    check((await p.inputValue('.ai-form select[aria-label="Sound from"]')).length > 0, 'a piece of sound opens the AI form with that sound chosen');
    check(await p.isVisible('.ai-form .segmented button[aria-pressed="true"]:has-text("My media")'), 'and the Sound row set to it');

    // The whole job in one form: an AI clip with the sound of a recording.
    await toHome();
    await p.click('.sidebar .nav-item:has-text("Generate with AI")');
    await p.waitForSelector('.panel .ai-form textarea');
    await p.selectOption('.ai-form select[aria-label="Model"]', 'runway:text-to-video:veo3.1');
    await wait(150);
    await p.selectOption('.ai-form select[aria-label="Length"]', 'trim:3');
    await wait(100);
    check((await p.textContent('.ai-form')).includes('trimmed to 3 s when it lands'), 'the form says when a model cannot make the length');
    await p.click('.ai-form .segmented button:has-text("My media")');
    check(await p.isDisabled('.ai-form button:has-text("Generate")'), 'My media needs a choice before generating');
    await p.selectOption('.ai-form select[aria-label="Sound from"]', { label: 'clip-a.mp4' });
    await p.waitForSelector('.ai-form .sound-window');
    await p.fill('.ai-form [aria-label="Sound starts at"]', '00:01.0');
    await p.keyboard.press('Tab');
    await p.fill('.ai-form textarea', 'A paper boat in the rain');
    await shot(p, '52-ai-sound-row');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForSelector('.clip.video', { timeout: 15000 });
    await p.waitForSelector('.clip.audio', { timeout: 5000 });
    await wait(300);
    doc = await stored();
    const made = doc.items.find((i) => i.type === 'video');
    const under = doc.items.find((i) => i.type === 'audio');
    check(made.muted && under.start === made.start && Math.abs(under.trimStart - 1) < 0.05, 'the clip and the chosen sound land together, lined up', JSON.stringify({ s: under.start, t: under.trimStart, d: under.duration, v: made.duration }));
    check(Math.abs(made.duration - 3) < 0.05 && Math.abs(under.duration - 3) < 0.05, 'both are trimmed to the length asked for', JSON.stringify({ d: under.duration, v: made.duration }));
    await p.keyboard.press(`${MOD}+z`);
    await wait(200);
    check((await pclips()).length === 0, 'and they are one step to undo');
    await p.keyboard.press(`${MOD}+Shift+z`);
    await wait(200);
    await blank([media('clip-a.mp4')]);
    await p.click('.rail-item:has-text("AI tools")');
    await p.waitForSelector('.ai-form textarea');
    await p.selectOption('.ai-form select[aria-label="Model"]', 'fal:text-to-video:minimax/h3-max/text-to-video');

    // A failure is explained, and can be retried
    await p.click('.rail-item:has-text("AI tools")');
    await p.waitForSelector('.ai-form');
    fake.failJobsWith = 'The model could not process this prompt.';
    await p.fill('.ai-form textarea', 'This one fails');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForSelector('.ai-job[data-job-state="failed"]', { timeout: 10000 });
    await p.waitForSelector('.toast.error', { timeout: 3000 });
    check((await p.textContent('.ai-job[data-job-state="failed"]')).includes('could not process'), 'a failed job says why');
    await shot(p, '46-ai-failed');
    fake.failJobsWith = null;
    const clipsBefore = (await pclips()).length;
    await p.click('.ai-job[data-job-state="failed"] [aria-label="Try again"]');
    await p.waitForFunction((n) => document.querySelectorAll('.clip').length > n, clipsBefore, { timeout: 15000 });
    check(true, 'a failed job can be run again');

    // Finishing while the project is closed
    await wait(300);
    fake.pollsToFinish = 1000;
    await p.fill('.ai-form textarea', 'Finished while away');
    await p.click('.ai-form button:has-text("Generate")');
    await p.waitForSelector('.ai-job[data-job-state="running"], .ai-job[data-job-state="queued"]', { timeout: 8000 });
    const projectName = await p.inputValue('.project-name');
    const count = (await pclips()).length;
    await toHome();
    fake.pollsToFinish = 1;
    await p.waitForSelector('.toast:has-text("is ready")', { timeout: 15000 });
    check(true, 'a result arriving while away is announced');
    await p.click(`.recent:has-text("${projectName}")`);
    await p.waitForSelector('.editor .clip');
    await p.waitForFunction((n) => document.querySelectorAll('.clip').length === n + 1, count, { timeout: 8000 });
    await wait(500);
    check((await pclips()).length === count + 1, 'it is placed when the project next opens, exactly once');
    fake.pollsToFinish = 2;

    // Talking character from the home page
    await toHome();
    await p.click('.sidebar .nav-item:has-text("Video from a script")');
    await p.click('[role="tab"]:has-text("Script")');
    await p.fill('.prompt-input', 'Hello, and welcome to the launch. We have something new to show you today.');
    await p.click('.pill:has-text("Colour background")');
    await p.click('.menu-item:has-text("Talking character")');
    await wait(300);
    check(await p.isDisabled('button:has-text("Generate video")'), 'a talking character needs a photo first');
    await stubOpenDialog(a, [media('photo.jpg')]);
    await p.click('.pill:has-text("Choose a photo")');
    await p.waitForSelector('.pill:has-text("photo.jpg")', { timeout: 8000 });
    await shot(p, '47-ai-talking-setup');
    await p.click('button:has-text("Generate video")');
    await p.waitForSelector('.modal');
    check((await p.textContent('.modal')).includes('billed to your account'), 'spending is confirmed first');
    await p.click('.modal-foot button:has-text("Generate")');
    await p.waitForSelector('.editor', { timeout: 30000 });
    await p.waitForSelector('.clip.video', { timeout: 20000 });
    await wait(400);
    doc = await stored();
    const talking = doc.items.find((i) => i.type === 'video');
    check(talking?.muted === true, 'the talking video is silent, so the voice is not doubled');
    check(doc.items.some((i) => i.type === 'audio'), 'the voice-over stays on its own track');
    check(doc.items.filter((i) => i.type === 'text' && i.subtitle).length >= 1, 'subtitles are in place');
    const fabric = fake.callsTo('/fal-queue/veed/fabric-1.0', 'POST').at(-1);
    check(!!fabric?.body.image_url && !!fabric?.body.audio_url, 'the photo and the voice went to Fabric');
    await shot(p, '48-ai-talking-editor');

    // AI scenes from the home page
    await toHome();
    await p.click('.sidebar .nav-item:has-text("Video from a script")');
    await p.click('[role="tab"]:has-text("Script")');
    await p.fill('.prompt-input', 'The sun rises over the old harbour. Fishing boats head out into the bay. By noon the market is full of people. Night falls and the lights come on.');
    await p.click('.pill:has-text("Colour background")');
    await p.click('.menu-item:has-text("AI scenes")');
    await wait(300);
    await p.click('button:has-text("Generate video")');
    await p.waitForSelector('.modal');
    const offer = await p.textContent('.modal h2');
    check(/Generate about \d+ scene/.test(offer), 'the number of scenes is shown before anything is spent', offer);
    fake.pollsToFinish = 8;
    await p.click('.modal-foot button:has-text("Generate")');
    await p.waitForSelector('.editor', { timeout: 40000 });
    await p.waitForSelector('.tl-pending', { timeout: 8000 });
    await p.waitForSelector('.panel .ai-job', { timeout: 5000 });
    check(true, 'with generations running, the editor opens on their progress');
    const pending = (await p.$$('.tl-pending')).length;
    check(pending >= 2, 'each scene is marked on the timeline while it generates', String(pending));
    await shot(p, '49-ai-scenes-pending');
    fake.pollsToFinish = 2;
    await p.waitForFunction((n) => document.querySelectorAll('.clip.video').length === n, pending, { timeout: 25000 });
    await wait(600);
    await shot(p, '50-ai-scenes-done');
    doc = await stored();
    const scenes = doc.items.filter((i) => i.type === 'video').sort((x, y) => x.start - y.start);
    check(scenes.every((s) => s.muted), 'scene footage is silent under the narration');
    check(scenes.every((s, i) => i === 0 || Math.abs(s.start - (scenes[i - 1].start + scenes[i - 1].duration)) < 0.6), 'scenes cover the narration end to end', JSON.stringify(scenes.map((s) => [s.start, s.duration])));
    check(scenes.every((s) => s.h >= doc.settings.height - 1 && s.w >= doc.settings.width - 1), 'scenes fill the frame');

    // The whole thing still exports
    await exportVideo(p);
    await p.waitForSelector('.video-player', { timeout: 90000 });
    const l2 = await lib();
    const m = l2.projects.filter((x) => x.lastExport).sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const file = join(second, 'library', 'exports', m.id, m.lastExport.file);
    check(existsSync(file) && probe(file).streams.some((s) => s.codec_type === 'audio'), 'an AI video exports like any other, with its narration');

    // Generate with AI goes straight to the panel, and leaves nothing behind if nothing was made.
    await toHome();
    const projectsBefore = (await lib()).projects.length;
    await p.click('.sidebar .nav-item:has-text("Generate with AI")');
    await p.waitForSelector('.panel .ai-form textarea', { timeout: 10000 });
    check(true, 'Generate with AI opens the AI panel');
    await toHome();
    await wait(400);
    check((await lib()).projects.length === projectsBefore, 'walking away from it leaves no empty project');
    await p.click('.sidebar .nav-item:has-text("Media")');
    await p.waitForSelector('.asset-card:has-text("A paper boat on a stream")', { timeout: 8000 });
    check(true, 'what was generated in a project is in Media');

    // Stopping
    await toHome();
    await p.click('.sidebar .nav-item:has-text("AI connections")');
    await p.waitForSelector('[data-provider="fal"] button:has-text("Disconnect")');
    await p.click('[data-provider="fal"] button:has-text("Disconnect")');
    await p.waitForSelector('[aria-label="fal.ai API key"]');
    check(!readFileSync(join(second, 'ai-keys.json'), 'utf8').includes('"fal"'), 'disconnecting removes the key');
    await p.click('.modal-foot button:has-text("Done")');
  } finally {
    allErrors.push(...inst.errors);
    await shot(p, 'ai-last').catch(() => undefined);
    await inst.app.close().catch(() => undefined);
    await fake.close();
    cleanup(second);
  }
});

section('topic', async () => {
  // Drafting from a topic, against a local stand-in for the API: this checks the exact request the app sends.
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'Teams that write things down move faster. Here is why it works.' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const second = newDataDir();
  const inst = await launch(second, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-test' });
  const p = inst.page;
  try {
    await p.click('.sidebar .nav-item:has-text("Video from a script")');
    await p.click('[role="tab"]:has-text("Topic")');
    await p.fill('.prompt-input', 'Why teams should write things down');
    await p.click('.pill:has-text("More options")');
    await p.click('.pill:has-text("Tone of voice")');
    await p.click('.menu-item:has-text("Calm")');
    await p.click('.pill:has-text("30s")');
    await p.click('.menu-item:has-text("60 seconds")');
    await p.click('button:has-text("Write script")');
    await p.waitForSelector('button:has-text("Regenerate")', { timeout: 15000 });
    check((await p.inputValue('.prompt-input')).startsWith('Teams that write'), 'the draft comes back for review before anything is generated');
    await shot(p, '33-topic-review');
    const r = seen[0];
    check(r.url.startsWith('/v1/messages'), 'the request goes to the Messages API', r.url);
    check(r.body.model === 'claude-opus-5-5', 'the current default model is used', r.body.model);
    check(r.body.fallbacks === 'default' && String(r.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), 'refusal fallback is switched on', String(r.headers['anthropic-beta']));
    check(!('thinking' in r.body) && !('temperature' in r.body), 'no parameters the model rejects');
    const prompt = r.body.messages[0].content;
    check(prompt.includes('Why teams') && prompt.includes('Tone of voice: Calm') && prompt.includes('60 seconds'), 'topic, tone and target length reach the writer');
    await p.click('button:has-text("Generate video")');
    await p.waitForSelector('.video-player', { timeout: 120000 });
    await p.waitForSelector('button:has-text("Reuse topic")');
    await p.click('button:has-text("Reuse topic")');
    await p.waitForSelector('.prompt-input');
    check((await p.inputValue('.prompt-input')) === 'Why teams should write things down', 'Reuse topic fills in the topic again');
    check(await p.isVisible('.pill:has-text("Calm")'), 'and keeps the settings');
  } finally {
    allErrors.push(...inst.errors);
    await inst.app.close().catch(() => undefined);
    server.close();
    cleanup(second);
  }
});

// ---------------------------------------------------------------- run

const order = ['start', 'timeline', 'review', 'text', 'export', 'formats', 'library', 'persistence', 'phone', 'recorder', 'script', 'brand', 'tools', 'rotation', 'themes', 'update', 'topic', 'ai'];
for (const name of order) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n== ${name}`);
  try {
    await sections[name]();
  } catch (err) {
    check(false, `section ${name} stopped`, err.message.split('\n')[0]);
    await shot(page, `fail-${name}`).catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
    // Tidy up for the next section. A window that has gone must not stop the rest of the run.
    for (let i = 0; i < 5 && (await page.$('.modal [aria-label="Close"]').catch(() => null)); i++) {
      await page.click('.modal [aria-label="Close"]', { timeout: 3000 }).catch(() => undefined);
    }
  }
}

const failed = summary([...allErrors, ...errors]);
await app.close().catch(() => undefined);
cleanup(dir);
process.exit(failed ? 1 : 0);
