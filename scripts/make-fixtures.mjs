// Generates small test media in every supported format into tests/fixtures/media.
// Usage: node scripts/make-fixtures.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ffmpegPath } = require('ffmpeg-ffprobe-static');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures', 'media');
mkdirSync(out, { recursive: true });

function ff(name, args) {
  const target = join(out, name);
  if (existsSync(target) && !process.argv.includes('--force')) return;
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args, target], { encoding: 'utf8' });
  if (r.status !== 0) console.error(`FAILED ${name}\n${r.stderr}`);
  else console.log(`made ${name}`);
}

const lavfi = (spec) => ['-f', 'lavfi', '-i', spec];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const aac = ['-c:a', 'aac', '-b:a', '128k'];
const bt709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
// The FFmpeg in Mac builds has no libaom, and either encoder makes a valid AVIF.
const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout;
const av1 = encoders.includes('libaom-av1') ? ['-c:v', 'libaom-av1', '-still-picture', '1', '-cpu-used', '8'] : ['-c:v', 'libsvtav1', '-preset', '8'];

// --- video
ff('clip-a.mp4', [...lavfi('testsrc2=s=1280x720:r=30:d=6'), ...lavfi('sine=f=440:d=6'), ...h264, ...bt709, ...aac, '-shortest']);
ff('clip-b.mp4', [...lavfi('smptehdbars=s=1920x1080:r=25:d=4'), ...lavfi('sine=f=880:d=4'), ...h264, ...bt709, ...aac, '-shortest']);
ff('portrait.mp4', [...lavfi('testsrc=s=720x1280:r=30:d=5'), ...lavfi('sine=f=330:d=5'), ...h264, ...aac, '-shortest']);
ff('silent.mp4', [...lavfi('testsrc2=s=640x360:r=24:d=3'), ...h264]);
ff('fast60.mp4', [...lavfi('testsrc2=s=1280x720:r=60:d=3'), ...h264]);
ff('hevc.mp4', [...lavfi('testsrc2=s=1280x720:r=30:d=3'), ...lavfi('sine=f=500:d=3'), '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...aac, '-shortest']);
ff('hdr.mp4', [
  ...lavfi('testsrc2=s=1280x720:r=30:d=3'),
  // setparams as well: newer FFmpeg takes these tags from the frames, and ignores the output options.
  '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
  '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p10le',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
]);
ff('vp9.webm', [...lavfi('testsrc2=s=854x480:r=30:d=3'), ...lavfi('sine=f=600:d=3'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest']);
ff('matroska.mkv', [...lavfi('testsrc2=s=854x480:r=30:d=3'), ...lavfi('sine=f=610:d=3'), '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libvorbis', '-shortest']);
ff('old.avi', [...lavfi('testsrc=s=640x480:r=25:d=3'), ...lavfi('sine=f=620:d=3'), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-shortest']);
ff('flash.flv', [...lavfi('testsrc=s=640x480:r=25:d=3'), ...lavfi('sine=f=630:d=3'), '-c:v', 'flv', '-c:a', 'libmp3lame', '-ar', '44100', '-shortest']);
ff('stream.ts', [...lavfi('testsrc2=s=1280x720:r=30:d=3'), ...lavfi('sine=f=640:d=3'), ...h264, ...aac, '-shortest']);
ff('theora.ogv', [...lavfi('testsrc=s=640x480:r=25:d=3'), ...lavfi('sine=f=650:d=3'), '-c:v', 'libtheora', '-q:v', '6', '-c:a', 'libvorbis', '-shortest']);
ff('prores.mov', [...lavfi('testsrc2=s=1280x720:r=30:d=2'), ...lavfi('sine=f=660:d=2'), '-c:v', 'prores_ks', '-profile:v', '1', '-c:a', 'pcm_s16le', '-shortest']);
ff('phone.m4v', [...lavfi('testsrc2=s=1280x720:r=30:d=3'), ...lavfi('sine=f=670:d=3'), ...h264, ...aac, '-shortest']);
ff('anim.gif', [...lavfi('testsrc=s=320x240:r=10:d=2')]);
ff('alpha.webm', [
  ...lavfi("color=c=black@0.0:s=400x400:r=30:d=2,format=rgba,geq=r='255':g='200':b='0':a='if(lt(hypot(X-200,Y-200),150+30*sin(T*6)),255,0)'"),
  '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0',
]);

// --- audio
ff('tone.mp3', [...lavfi('sine=f=220:d=8'), '-c:a', 'libmp3lame', '-b:a', '192k']);
ff('tone.wav', [...lavfi('sine=f=240:d=4')]);
ff('tone.flac', [...lavfi('sine=f=260:d=4')]);
ff('tone.ogg', [...lavfi('sine=f=280:d=4'), '-c:a', 'libvorbis']);
ff('tone.oga', [...lavfi('sine=f=290:d=4'), '-c:a', 'libvorbis', '-f', 'ogg']);
ff('tone.m4a', [...lavfi('sine=f=300:d=4'), ...aac]);
ff('tone.aac', [...lavfi('sine=f=320:d=4'), ...aac, '-f', 'adts']);

// --- images
ff('photo.jpg', [...lavfi('mandelbrot=s=1600x1200'), '-frames:v', '1', '-q:v', '3']);
ff('wide.jpeg', [...lavfi('testsrc2=s=1920x1080'), '-frames:v', '1', '-q:v', '3']);
ff('logo.png', [
  ...lavfi("color=c=black@0.0:s=400x400,format=rgba,geq=r='235':g='64':b='80':a='if(lt(hypot(X-200,Y-200),180),255,0)'"),
  '-frames:v', '1',
]);
ff('pic.webp', [...lavfi('testsrc=s=800x600'), '-frames:v', '1']);
ff('pic.avif', [...lavfi('testsrc=s=800x600'), '-frames:v', '1', ...av1]);

// --- files that carry rotation in their metadata, the way phones write them
const rotated = join(out, 'rotated.mp4');
if (!existsSync(rotated) || process.argv.includes('--force')) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '-90', '-i', join(out, 'clip-a.mp4'), '-c', 'copy', rotated], { encoding: 'utf8' });
  if (r.status !== 0) console.error(`FAILED rotated.mp4\n${r.stderr}`);
  else console.log('made rotated.mp4');
}

// A JPEG with an EXIF block saying "turn 90 degrees clockwise to display". The picture itself is
// red on its left half, so a viewer that honours the tag shows red on top.
ff('exif-source.jpg', [...lavfi('color=c=red:s=200x300,pad=400:300:0:0:color=blue'), '-frames:v', '1', '-q:v', '2']);
{
  const jpeg = readFileSync(join(out, 'exif-source.jpg'));
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first directory at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // Orientation (SHORT) = 6
    0x00, 0x00, 0x00, 0x00, // no further directories
  ]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  writeFileSync(join(out, 'exif-rotated.jpg'), Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
}

// --- subtitles, and a file that must be rejected on import
writeFileSync(
  join(out, 'subs.srt'),
  ['1', '00:00:00,500 --> 00:00:02,000', 'First subtitle line', '', '2', '00:00:02,500 --> 00:00:04,000', 'Second line,', 'on two rows', '', '3', '00:00:04,200 --> 00:00:05,500', 'Third & final', ''].join('\n'),
);
writeFileSync(join(out, 'notes.txt'), 'not a media file\n');
