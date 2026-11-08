// Searching and fetching free clips against a stand-in that speaks Pexels' and Pixabay's protocols.
// These check what goes over the wire, what is kept, and what happens when things go wrong.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClipProgress, ClipServiceId } from '../../src/shared/clips.ts';
import { AssetManager } from '../../src/main/assets.ts';
import { KeyStore, type Cipher } from '../../src/main/ai/keys.ts';
import { FreeClips } from '../../src/main/clips/freeClips.ts';
import { pexels } from '../../src/main/clips/pexels.ts';
import { pixabay } from '../../src/main/clips/pixabay.ts';
import { LibraryStore } from '../../src/main/library.ts';
import { Paths } from '../../src/main/paths.ts';
import { CLIP_KEYS, CLIPS_IN_LIBRARY, FakeProviders } from '../support/fakeProviders.mts';

const cipher: Cipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(t).reverse(),
  decrypt: (d) => Buffer.from(d).reverse().toString(),
};

const HD = { width: 1920, height: 1080 };
const DAY = 24 * 60 * 60 * 1000;

let server: FakeProviders;

before(async () => {
  server = await new FakeProviders().start();
  process.env.VIEWEDITOR_AI_HOSTS = server.hosts;
});

after(async () => {
  delete process.env.VIEWEDITOR_AI_HOSTS;
  await server.close();
});

async function setup(connect: ClipServiceId[] = ['pexels'], root = mkdtempSync(join(tmpdir(), 'vieweditor-clips-'))) {
  const lib = new LibraryStore(new Paths(join(root, 'library')));
  await lib.init();
  const assets = new AssetManager(lib);
  const keys = new KeyStore<ClipServiceId>(join(root, 'clip-keys.json'), cipher);
  await keys.load();
  for (const id of connect) await keys.set(id, CLIP_KEYS[id]);
  const progress: ClipProgress[] = [];
  let time = Date.now();
  const clips = new FreeClips({ lib, assets, keys, services: [pexels, pixabay], searchDir: join(root, 'clip-searches'), onProgress: (p) => progress.push(p), now: () => time });
  return { root, lib, assets, keys, clips, progress, later: (ms: number) => (time += ms) };
}

const words = (() => {
  let n = 0;
  // A different search each time, so a test never finds what another one kept.
  return () => `search number ${++n}`;
})();

const search = (query = words(), page = 1) => ({ query, shape: 'any' as const, page });

test('a key the service refuses is not stored, and says so', async () => {
  const c = await setup([]);
  await assert.rejects(c.clips.connect('pexels', 'wrong-key'), /Pexels did not accept this key/);
  await assert.rejects(c.clips.connect('pixabay', 'wrong-key'), /Pixabay did not accept this key/);
  assert.deepEqual(c.clips.services().map((s) => s.connected), [false, false]);
  assert.ok(!existsSync(join(c.root, 'clip-keys.json')));
});

test('a working key is stored encrypted, and survives a restart', async () => {
  const c = await setup([]);
  const status = await c.clips.connect('pexels', `  ${CLIP_KEYS.pexels}\n`);
  assert.equal(status.connected, true);
  assert.ok(!readFileSync(join(c.root, 'clip-keys.json'), 'utf8').includes(CLIP_KEYS.pexels));
  const again = new KeyStore<ClipServiceId>(join(c.root, 'clip-keys.json'), cipher);
  await again.load();
  assert.equal(again.get('pexels'), CLIP_KEYS.pexels);
  await c.clips.disconnect('pexels');
  assert.equal(c.clips.services()[0].connected, false);
});

test('searching needs a service', async () => {
  const c = await setup([]);
  await assert.rejects(c.clips.search(search()), /Connect Pexels or Pixabay first/);
});

test('Pexels is asked with its key in the header, and what was typed', async () => {
  const c = await setup(['pexels']);
  const query = words();
  const found = await c.clips.search({ query: `  ${query}  `, shape: 'tall', page: 1 });
  const call = server.callsTo('/pexels/v1/videos/search').at(-1)!;
  const sent = new URL(call.path, 'http://x').searchParams;
  assert.equal(call.headers.authorization, CLIP_KEYS.pexels);
  assert.equal(sent.get('query'), query);
  assert.equal(sent.get('orientation'), 'portrait');
  assert.equal(sent.get('per_page'), '20');
  assert.equal(found.clips.length, 20);
  assert.equal(found.hasMore, true);
  assert.equal(found.clips[0].height > found.clips[0].width, true);
});

test('an empty search shows what is popular, and paging reaches an end', async () => {
  const c = await setup(['pexels']);
  const first = await c.clips.search({ query: '', shape: 'any', page: 1 });
  assert.ok(server.callsTo('/pexels/v1/videos/popular').length > 0);
  assert.equal(first.clips.length, 20);
  const second = await c.clips.search({ query: '', shape: 'any', page: 2 });
  assert.equal(second.clips.length, CLIPS_IN_LIBRARY - 20);
  assert.equal(second.hasMore, false);
});

test('the popular list keeps only the shape asked for', async () => {
  const c = await setup(['pexels']);
  const found = await c.clips.search({ query: '', shape: 'tall', page: 1 });
  assert.equal(found.clips.length, 4, 'every fifth one is tall');
  assert.ok(!server.callsTo('/pexels/v1/videos/popular').at(-1)!.path.includes('orientation'), 'that list cannot be asked for a shape');
});

test('Pixabay is asked with safe search on', async () => {
  const c = await setup(['pixabay']);
  const query = words();
  const found = await c.clips.search(search(query));
  const sent = new URL(server.callsTo('/pixabay-api/videos/').at(-1)!.path, 'http://x').searchParams;
  assert.equal(sent.get('key'), CLIP_KEYS.pixabay);
  assert.equal(sent.get('q'), query);
  assert.equal(sent.get('safesearch'), 'true');
  assert.equal(found.clips[0].key, 'pixabay:1001');
  assert.equal(found.clips[0].files.length, 3, 'the size that does not exist is gone');
});

test('a long search is cut to what Pixabay accepts', async () => {
  const c = await setup(['pixabay']);
  await c.clips.search(search(`${words()} ${'x'.repeat(200)}`));
  const sent = new URL(server.callsTo('/pixabay-api/videos/').at(-1)!.path, 'http://x').searchParams;
  assert.equal(sent.get('q')!.length, 100);
});

test('with two services the results take turns', async () => {
  const c = await setup(['pexels', 'pixabay']);
  const found = await c.clips.search(search());
  assert.equal(found.clips.length, 40);
  assert.deepEqual(found.clips.slice(0, 4).map((x) => x.service), ['pexels', 'pixabay', 'pexels', 'pixabay']);
});

test('one service failing leaves the other, and says what happened', async () => {
  const c = await setup(['pexels', 'pixabay']);
  server.refuseClips = 429;
  server.refusePixabayOnly = true;
  try {
    const found = await c.clips.search(search());
    assert.equal(found.clips.length, 20);
    assert.ok(found.clips.every((x) => x.service === 'pexels'));
    assert.deepEqual(found.problems, ['API rate limit exceeded']);
  } finally {
    server.refuseClips = null;
    server.refusePixabayOnly = false;
  }
});

test('every service failing is an error a person can read', async () => {
  const c = await setup(['pexels']);
  server.refuseClips = 500;
  try {
    await assert.rejects(c.clips.search(search()), /Too many requests/);
  } finally {
    server.refuseClips = null;
  }
});

test('a key that stops working is explained, not blamed on AI connections', async () => {
  const c = await setup([]);
  await c.keys.set('pexels', 'revoked-key');
  await assert.rejects(c.clips.search(search()), /Pexels no longer accepts your key\. Connect it again under Manage\./);
});

test('a search is kept for 24 hours, across restarts, and then asked again', async () => {
  const c = await setup(['pixabay']);
  const query = words();
  const count = (): number => server.callsTo('/pixabay-api/videos/').filter((x) => x.path.includes(encodeURIComponent(query).replace(/%20/g, '+'))).length;
  await c.clips.search(search(query));
  assert.equal(count(), 1);
  await c.clips.search(search(query.toUpperCase()));
  assert.equal(count(), 1, 'capitals do not make it a different search');
  c.later(DAY - 60_000);
  await c.clips.search(search(query));
  assert.equal(count(), 1);

  const restarted = await setup(['pixabay'], c.root);
  await restarted.clips.search(search(query));
  assert.equal(count(), 1, 'a restart does not lose it');

  c.later(120_000);
  await c.clips.search(search(query));
  assert.equal(count(), 2);
});

test('keys are never written into kept searches', async () => {
  const c = await setup(['pexels', 'pixabay']);
  await c.clips.search(search());
  const dir = join(c.root, 'clip-searches');
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
  assert.ok(text.length > 100);
  assert.ok(!text.includes(CLIP_KEYS.pexels));
  assert.ok(!text.includes(CLIP_KEYS.pixabay));
});

test('old searches are cleared away', async () => {
  const c = await setup(['pexels']);
  await c.clips.search(search());
  const dir = join(c.root, 'clip-searches');
  const [file] = readdirSync(dir);
  await c.clips.tidySearches();
  assert.equal(readdirSync(dir).length, 1, 'a new one stays');
  const old = new Date(statSync(join(dir, file)).mtimeMs - DAY - 1000);
  utimesSync(join(dir, file), old, old);
  await c.clips.tidySearches();
  assert.equal(readdirSync(dir).length, 0);
});

test('adding a clip fetches the right size into Media, with its credit', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  const asset = await c.clips.add({ key: clips[0].key, fit: HD });
  assert.ok(asset);
  assert.equal(server.callsTo('/files/clip-1-hd.mp4').length > 0, true);
  assert.equal(asset.kind, 'video');
  assert.equal(asset.source, 'stock');
  assert.equal(asset.name, 'Waves on a beach.mp4');
  assert.deepEqual(asset.credit, {
    key: 'pexels:1', service: 'Pexels', creator: 'Ruvim Miksanskiy', creatorUrl: 'https://www.pexels.com/@digitech',
    pageUrl: 'https://www.pexels.com/video/waves-on-a-beach-1/', licenseUrl: 'https://www.pexels.com/license/',
  });
  assert.ok(c.lib.data.assets.some((a) => a.id === asset.id));
  assert.ok(existsSync(c.lib.paths.assetOriginal(asset)));
  assert.deepEqual(readdirSync(c.lib.paths.tmpDir), [], 'nothing is left in the temporary folder');
  await c.assets.whenIdle();
});

test('a 4K project gets the 4K file', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  await c.clips.add({ key: clips[1].key, fit: { width: 3840, height: 2160 } });
  assert.ok(server.callsTo('/files/clip-2-4k.mp4').length > 0);
  await c.assets.whenIdle();
});

test('a clip already in Media is not fetched again, and asking twice at once fetches once', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  const before = server.callsTo('/files/clip-3-').length;
  const [one, two] = await Promise.all([c.clips.add({ key: clips[2].key, fit: HD }), c.clips.add({ key: clips[2].key, fit: HD })]);
  assert.equal(one?.id, two?.id);
  const again = await c.clips.add({ key: clips[2].key, fit: HD });
  assert.equal(again?.id, one?.id);
  assert.equal(server.callsTo('/files/clip-3-').length, before + 1);
  assert.equal(c.lib.data.assets.length, 1);
  await c.assets.whenIdle();
});

test('a clip deleted from Media can be fetched again', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  const first = await c.clips.add({ key: clips[0].key, fit: HD });
  await c.assets.whenIdle();
  await c.assets.remove([first!.id]);
  const second = await c.clips.add({ key: clips[0].key, fit: HD });
  assert.notEqual(second?.id, first?.id);
  await c.assets.whenIdle();
});

test('a download reports how far along it is, and can be stopped', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  server.holdClipFiles = true;
  try {
    const pending = c.clips.add({ key: clips[0].key, fit: HD });
    for (let i = 0; i < 100 && !c.progress.length; i++) {
      c.later(1000);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(c.progress.length > 0, 'progress was reported');
    assert.equal(c.progress[0].key, clips[0].key);
    assert.ok(c.progress[0].fraction! > 0 && c.progress[0].fraction! < 1);
    c.clips.cancel(clips[0].key);
    assert.equal(await pending, null);
    assert.equal(c.lib.data.assets.length, 0);
    assert.deepEqual(readdirSync(c.lib.paths.tmpDir), []);
  } finally {
    server.releaseClipFiles();
  }
});

test('the page can only ask for clips a search has shown', async () => {
  const c = await setup(['pexels']);
  await assert.rejects(c.clips.add({ key: 'pexels:999', fit: HD }), /Search again/);
  assert.equal(c.clips.address('pexels:999', 'picture'), null);
  const { clips } = await c.clips.search(search());
  assert.equal(c.clips.address(clips[0].key, 'picture'), clips[0].picture);
  assert.equal(c.clips.address(clips[0].key, 'preview'), clips[0].preview);
  assert.equal(c.clips.address(clips[0].key, 'anything else'), null, 'the full-size files are not for the page to read');
});

test('a file that has gone is explained, and the kept searches go with it', async () => {
  const c = await setup(['pexels']);
  const query = words();
  const { clips } = await c.clips.search(search(query));
  server.clipFilesGone = true;
  try {
    await assert.rejects(c.clips.add({ key: clips[0].key, fit: HD }), /Pexels no longer offers this file/);
  } finally {
    server.clipFilesGone = false;
  }
  assert.ok(!existsSync(join(c.root, 'clip-searches')));
  assert.equal(c.lib.data.assets.length, 0);
});

test('a size that cannot be read falls back to Full HD', async () => {
  const c = await setup(['pexels']);
  const { clips } = await c.clips.search(search());
  await c.clips.add({ key: clips[4].key, fit: { width: 0, height: 0 } });
  assert.ok(server.callsTo('/files/clip-5-hd.mp4').length > 0);
  await c.assets.whenIdle();
});
