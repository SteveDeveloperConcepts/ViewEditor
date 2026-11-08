// Reading what the stock video libraries send, using the examples in their documentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileFor, interleave, makeClip, shapeOf, webAddress } from '../../src/shared/clips.ts';
import { safeFileName } from '../../src/shared/constants.ts';
import { readPexels, type PexelsAnswer } from '../../src/main/clips/pexels.ts';
import { readPixabay, type PixabayAnswer } from '../../src/main/clips/pixabay.ts';
import type { ClipQuery } from '../../src/main/clips/service.ts';

const q = (patch: Partial<ClipQuery> = {}): ClipQuery => ({ query: 'forest', shape: 'any', page: 1, perPage: 20, ...patch });

const link = (name: string): string => `https://player.vimeo.com/external/291648067.${name}?s=abc&oauth2_token_id=57447761`;

/** https://www.pexels.com/api/documentation/#videos-search */
const pexelsExample: PexelsAnswer = {
  page: 1,
  per_page: 1,
  total_results: 20475,
  videos: [
    {
      id: 1448735,
      url: 'https://www.pexels.com/video/video-of-forest-1448735/',
      image: 'https://images.pexels.com/videos/1448735/free-video-1448735.jpg?fit=crop&w=1200&h=630&auto=compress&cs=tinysrgb',
      duration: 32,
      user: { name: 'Ruvim Miksanskiy', url: 'https://www.pexels.com/@digitech' },
      video_files: [
        { quality: 'sd', file_type: 'video/mp4', width: 640, height: 338, link: link('sd.mp4') },
        { quality: 'hd', file_type: 'video/mp4', width: 2048, height: 1080, link: link('hd.mp4') },
        { quality: 'hd', file_type: 'video/mp4', width: 4096, height: 2160, link: link('hd.mp4') },
        { quality: 'hd', file_type: 'video/mp4', width: 1366, height: 720, link: link('hd.mp4') },
        { quality: 'hd', file_type: 'video/mp4', width: 2732, height: 1440, link: link('hd.mp4') },
        { quality: 'sd', file_type: 'video/mp4', width: 960, height: 506, link: link('sd.mp4') },
        { quality: 'hls', file_type: 'video/mp4', width: null, height: null, link: link('m3u8') },
      ],
    },
  ],
};

const cdn = (size: string, ext: string): string => `https://cdn.pixabay.com/video/2015/08/08/125-135736646_${size}.${ext}`;

/** https://pixabay.com/api/docs/#api_search_videos */
const pixabayExample: PixabayAnswer = {
  totalHits: 42,
  hits: [
    {
      id: 125,
      pageURL: 'https://pixabay.com/videos/id-125/',
      tags: 'flowers, yellow, blossom',
      duration: 12,
      videos: {
        large: { url: cdn('large', 'mp4'), width: 1920, height: 1080, thumbnail: cdn('large', 'jpg') },
        medium: { url: cdn('medium', 'mp4'), width: 1280, height: 720, thumbnail: cdn('medium', 'jpg') },
        small: { url: cdn('small', 'mp4'), width: 640, height: 360, thumbnail: cdn('small', 'jpg') },
        tiny: { url: cdn('tiny', 'mp4'), width: 480, height: 270, thumbnail: cdn('tiny', 'jpg') },
      },
      user_id: 1281706,
      user: 'Coverr-Free-Footage',
    },
  ],
};

test('Pexels: a clip is read from the documented example', () => {
  const { clips, hasMore } = readPexels(pexelsExample, q(), true);
  assert.equal(clips.length, 1);
  const [clip] = clips;
  assert.equal(clip.key, 'pexels:1448735');
  assert.equal(clip.title, 'Video of forest');
  assert.equal(clip.creator, 'Ruvim Miksanskiy');
  assert.equal(clip.creatorUrl, 'https://www.pexels.com/@digitech');
  assert.equal(clip.pageUrl, 'https://www.pexels.com/video/video-of-forest-1448735/');
  assert.equal(clip.duration, 32);
  assert.deepEqual([clip.width, clip.height], [4096, 2160]);
  assert.ok(hasMore, 'thousands more are waiting');
});

test('Pexels: a stream is never offered as a file, even though it is listed as an mp4', () => {
  const [clip] = readPexels(pexelsExample, q(), true).clips;
  assert.equal(clip.files.length, 6);
  assert.ok(clip.files.every((f) => !f.url.includes('m3u8')));
});

test('Pexels: the last page is known from the total', () => {
  assert.equal(readPexels({ page: 2, per_page: 20, total_results: 25, videos: [] }, q({ page: 2 }), true).hasMore, false);
  assert.equal(readPexels({ page: 1, per_page: 20, total_results: 25, videos: [] }, q(), true).hasMore, true);
});

test('Pexels: the popular list is sorted by shape afterwards, because it cannot be asked for one', () => {
  assert.equal(readPexels(pexelsExample, q({ shape: 'tall' }), false).clips.length, 0);
  assert.equal(readPexels(pexelsExample, q({ shape: 'wide' }), false).clips.length, 1);
  assert.equal(readPexels(pexelsExample, q({ shape: 'tall' }), true).clips.length, 1, 'a search already asked for it');
});

test('Pexels: a video with nothing playable is left out', () => {
  const none: PexelsAnswer = { videos: [{ ...pexelsExample.videos![0], video_files: [pexelsExample.videos![0].video_files![6]] }] };
  assert.equal(readPexels(none, q(), true).clips.length, 0);
});

test('Pexels: an address without a description still gives a title', () => {
  const odd: PexelsAnswer = { videos: [{ ...pexelsExample.videos![0], url: 'https://www.pexels.com/video/1448735/' }] };
  assert.equal(readPexels(odd, q(), true).clips[0].title, 'Pexels video 1448735');
});

test('Pixabay: a clip is read from the documented example', () => {
  const { clips, hasMore } = readPixabay(pixabayExample, q());
  const [clip] = clips;
  assert.equal(clip.key, 'pixabay:125');
  assert.equal(clip.title, 'Flowers, yellow, blossom');
  assert.equal(clip.creator, 'Coverr-Free-Footage');
  assert.equal(clip.creatorUrl, 'https://pixabay.com/users/Coverr-Free-Footage-1281706/');
  assert.equal(clip.picture, cdn('tiny', 'jpg'));
  assert.deepEqual([clip.width, clip.height], [1920, 1080]);
  assert.equal(clip.files.length, 4);
  assert.ok(hasMore, '42 hits and 20 on a page');
  assert.equal(readPixabay(pixabayExample, q({ page: 3 })).hasMore, false);
});

test('Pixabay: a size that does not exist comes back with an empty address and is skipped', () => {
  const hit = pixabayExample.hits![0];
  const [clip] = readPixabay({ hits: [{ ...hit, videos: { ...hit.videos, large: { url: '', width: 0, height: 0, thumbnail: '' } } }] }, q()).clips;
  assert.equal(clip.files.length, 3);
  assert.deepEqual([clip.width, clip.height], [1280, 720]);
});

test('Pixabay: shapes are sorted afterwards, because it cannot be asked for one', () => {
  assert.equal(readPixabay(pixabayExample, q({ shape: 'tall' })).clips.length, 0);
  assert.equal(readPixabay(pixabayExample, q({ shape: 'wide' })).clips.length, 1);
});

test('the file to fetch is the smallest that is big enough', () => {
  const files = [640, 1366, 2048, 4096].map((width) => ({ width, height: Math.round(width * 0.53), url: `https://x.test/${width}` }));
  assert.equal(fileFor(files, { width: 1920, height: 1080 }).width, 2048);
  assert.equal(fileFor(files, { width: 3840, height: 2160 }).width, 4096);
  assert.equal(fileFor(files, { width: 640, height: 360 }).width, 640);
  assert.equal(fileFor(files, { width: 7680, height: 4320 }).width, 4096, 'or the biggest there is');
  assert.equal(fileFor(files, { width: 1080, height: 1920 }).width, 2048, 'a tall project asks for the same long edge');
});

test('a clip plays a small copy before anything is fetched', () => {
  const [clip] = readPexels(pexelsExample, q(), true).clips;
  assert.ok(clip.preview.includes('.sd.mp4'));
});

test('shapes', () => {
  assert.equal(shapeOf({ width: 1920, height: 1080 }), 'wide');
  assert.equal(shapeOf({ width: 1080, height: 1920 }), 'tall');
  assert.equal(shapeOf({ width: 1080, height: 1080 }), 'square');
  assert.equal(shapeOf({ width: 1000, height: 900 }), 'square', 'close enough');
});

test('results from two libraries take turns', () => {
  assert.deepEqual(interleave([[1, 3, 5, 6], [2, 4]]), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(interleave([[], [2]]), [2]);
  assert.deepEqual(interleave<number>([]), []);
});

test('only web addresses are kept from what a service sends', () => {
  assert.equal(webAddress('https://x.test/a'), 'https://x.test/a');
  assert.equal(webAddress('javascript:alert(1)'), '');
  assert.equal(webAddress(null), '');
  const parts = { id: 1, service: 'pexels' as const, title: 't', creator: 'c', creatorUrl: 'javascript:alert(1)', pageUrl: 'https://x.test/p', duration: 1, picture: 'file:///etc/passwd' };
  const clip = makeClip({ ...parts, files: [{ width: 10, height: 10, url: 'https://x.test/f.mp4' }, { width: 20, height: 20, url: 'file:///c:/secret.mp4' }] });
  assert.equal(clip?.creatorUrl, null);
  assert.equal(clip?.picture, '');
  assert.deepEqual(clip?.files.map((f) => f.url), ['https://x.test/f.mp4']);
  assert.equal(makeClip({ ...parts, pageUrl: 'nope', files: [{ width: 10, height: 10, url: 'https://x.test/f.mp4' }] }), null);
});

test('titles from a service are safe to name a file with', () => {
  assert.equal(safeFileName('Sea: waves / sand?'), 'Sea_ waves _ sand_');
  assert.equal(safeFileName('...'), 'video');
});
