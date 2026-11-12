// How the Mac apps are signed: the way electron-builder would, except that FFmpeg gets no entitlements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import signMac, { FFMPEG_ENTITLEMENTS, ffmpegTools, withFfmpegEntitlements } from '../../scripts/sign-mac.mjs';

const app = join(tmpdir(), 'release', 'mac-arm64', 'Homecut.app');
/** What electron-builder 26 picks for every file but the app itself, with the Release workflow's settings. */
const electronBuilder = (file: string) => ({
  entitlements: 'build/entitlements.mac.plist',
  hardenedRuntime: true,
  timestamp: undefined,
  requirements: undefined,
  additionalArguments: [],
  file,
});

test('FFmpeg and FFprobe get their own entitlements, and keep the rest of what electron-builder chose', () => {
  const options = withFfmpegEntitlements({ app, identity: 'ABC123', optionsForFile: electronBuilder });
  for (const tool of ffmpegTools(app)) {
    assert.deepEqual(options.optionsForFile(tool), { ...electronBuilder(tool), entitlements: FFMPEG_ENTITLEMENTS });
  }
  assert.equal(options.identity, 'ABC123');
});

test('they are found where the app runs them from', () => {
  const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-ffprobe-static');
  assert.deepEqual(ffmpegTools(app), [join(unpacked, 'ffmpeg'), join(unpacked, 'ffprobe')]);
});

test('everything else is signed as electron-builder would', () => {
  const options = withFfmpegEntitlements({ app, optionsForFile: electronBuilder });
  const others = [
    app,
    join(app, 'Contents', 'Frameworks', 'Homecut Helper (Renderer).app'),
    join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'),
    join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-ffprobe-static', 'ffmpeg.LICENSE'),
  ];
  for (const file of others) assert.deepEqual(options.optionsForFile(file), electronBuilder(file));
});

test('the ad-hoc build keeps its settings too', () => {
  const adhoc = (file: string) => ({ ...electronBuilder(file), hardenedRuntime: false });
  const options = withFfmpegEntitlements({ app, identity: '-', optionsForFile: adhoc });
  const [ffmpeg] = ffmpegTools(app);
  assert.deepEqual(options.optionsForFile(ffmpeg), { ...adhoc(ffmpeg), entitlements: FFMPEG_ENTITLEMENTS });
});

test('FFmpeg’s entitlements allow nothing', () => {
  const plist = readFileSync(FFMPEG_ENTITLEMENTS, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(plist, /<dict>\s*<\/dict>/);
  assert.doesNotMatch(plist, /<key>/);
});

test('signing stops when FFmpeg is not in the app, rather than leave it with Electron’s entitlements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vieweditor-sign-'));
  try {
    await assert.rejects(signMac({ app: join(dir, 'Homecut.app') }), /FFmpeg isn't where the app runs it from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
