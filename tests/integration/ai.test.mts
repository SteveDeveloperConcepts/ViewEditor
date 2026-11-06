// Generation jobs against a stand-in server that speaks each service's real protocol.
// These check what actually goes over the wire, and what happens when things go wrong.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiRequest, AiTask } from '../../src/shared/ai.ts';
import { AssetManager } from '../../src/main/assets.ts';
import { AiCatalog } from '../../src/main/ai/catalog.ts';
import { fal } from '../../src/main/ai/fal.ts';
import { AiJobs } from '../../src/main/ai/jobs.ts';
import { KeyStore, type Cipher } from '../../src/main/ai/keys.ts';
import { replicate } from '../../src/main/ai/replicate.ts';
import { runway } from '../../src/main/ai/runway.ts';
import { runFfprobe } from '../../src/main/ffmpeg.ts';
import { LibraryStore } from '../../src/main/library.ts';
import { Paths } from '../../src/main/paths.ts';
import { FakeProviders, KEYS } from '../support/fakeProviders.mts';
import { media } from './helpers.mts';

const cipher: Cipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(t).reverse(),
  decrypt: (d) => Buffer.from(d).reverse().toString(),
};

const providers = [fal, runway, replicate];
let server: FakeProviders;

before(async () => {
  server = await new FakeProviders().start();
  process.env.VIEWEDITOR_AI_HOSTS = server.hosts;
});

after(async () => {
  delete process.env.VIEWEDITOR_AI_HOSTS;
  await server.close();
});

async function setup(root = mkdtempSync(join(tmpdir(), 'vieweditor-ai-'))) {
  const lib = new LibraryStore(new Paths(join(root, 'library')));
  await lib.init();
  const assets = new AssetManager(lib);
  const keys = new KeyStore(join(root, 'ai-keys.json'), cipher);
  await keys.load();
  for (const [id, key] of Object.entries(KEYS)) await keys.set(id as keyof typeof KEYS, key);
  const catalog = new AiCatalog(root, providers, keys);
  const jobs = new AiJobs({ lib, assets, keys, catalog, providers, pollMs: 15 });
  return { root, lib, assets, keys, catalog, jobs };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function modelKey(c: Ctx, provider: string, id: string, task: AiTask): Promise<string> {
  const found = (await c.catalog.models(task)).find((m) => m.provider === provider && m.id === id);
  assert.ok(found, `${id} should be listed for ${task}`);
  return found.key;
}

function request(key: string, patch: Partial<AiRequest> = {}): AiRequest {
  return { modelKey: key, choices: { prompt: 'A red kite over a beach' }, target: { scope: 'workspace' }, placement: { kind: 'none' }, ...patch };
}

async function finished(c: Ctx, id: string) {
  await c.jobs.whenSettled(id);
  return c.lib.data.aiJobs!.find((j) => j.id === id)!;
}

async function importClip(c: Ctx, name: string) {
  const r = await c.assets.importFiles([media(name)], { scope: 'workspace' });
  await c.assets.whenIdle();
  return r.assets[0];
}

test('keys are stored encrypted and survive a restart', async () => {
  const c = await setup();
  const again = new KeyStore(join(c.root, 'ai-keys.json'), cipher);
  await again.load();
  assert.equal(again.get('fal'), KEYS.fal);
  const { readFile } = await import('node:fs/promises');
  assert.ok(!(await readFile(join(c.root, 'ai-keys.json'), 'utf8')).includes(KEYS.fal));
  await again.remove('fal');
  assert.equal(again.has('fal'), false);
});

test('a key that cannot be decrypted just needs entering again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vieweditor-ai-'));
  await writeFile(join(root, 'ai-keys.json'), JSON.stringify({ fal: 'AAAA' }));
  const store = new KeyStore(join(root, 'ai-keys.json'), { ...cipher, decrypt: () => { throw new Error('wrong machine'); } });
  await store.load();
  assert.equal(store.has('fal'), false);
});

test('connections are checked against each service', async () => {
  assert.equal(await runway.verify(KEYS.runway), '12,500 credits');
  assert.equal(await replicate.verify(KEYS.replicate), 'test-user');
  assert.equal(await fal.verify(KEYS.fal), null);
  await assert.rejects(fal.verify('wrong'), /did not accept this API key/);
  await assert.rejects(runway.verify('wrong'), /did not accept this API key/);
  await assert.rejects(replicate.verify('wrong'), /did not accept this API key/);
});

test('the catalogue only shows connected services, and remembers what it fetched', async () => {
  const c = await setup();
  await c.keys.remove('replicate');
  const models = await c.catalog.models('text-to-video');
  assert.ok(models.some((m) => m.provider === 'fal'));
  assert.ok(models.some((m) => m.provider === 'runway'));
  assert.ok(!models.some((m) => m.provider === 'replicate'));
  const before = server.callsTo('/fal-api/v1/models').length;
  await c.catalog.models('text-to-video');
  assert.equal(server.callsTo('/fal-api/v1/models').length, before, 'no second trip within a day');
  await c.catalog.models('text-to-video', true);
  assert.ok(server.callsTo('/fal-api/v1/models').length > before, 'refresh asks again');
});

test('when a catalogue cannot be reached, the saved list is used', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vieweditor-ai-'));
  const keys = new KeyStore(join(root, 'k.json'), cipher);
  await keys.set('fal', KEYS.fal);
  const broken = { ...fal, listModels: async () => { throw new Error('offline'); } };
  const bundled = await fal.listModels(null);
  const catalog = new AiCatalog(root, [broken], keys, { fal: bundled });
  assert.ok((await catalog.models('talking-photo')).some((m) => m.id === 'veed/fabric-1.0'));
});

test('fal: text to video from request to library', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  const seen: string[] = [];
  const stop = setInterval(() => seen.push(c.lib.data.aiJobs?.[0]?.state ?? ''), 3);
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'A red kite over a beach', duration: 5, aspect: '16:9', resolution: '768P' } }));
  const done = await finished(c, job.id);
  clearInterval(stop);

  assert.equal(done.state, 'done', done.error ?? '');
  const sent = server.callsTo('/fal-queue/minimax/h3-max/text-to-video', 'POST').at(-1)!;
  assert.equal(sent.headers.authorization, `Key ${KEYS.fal}`);
  assert.deepEqual(sent.body, { prompt_expansion_mode: 'balanced', prompt: 'A red kite over a beach', duration: 5, aspect_ratio: '16:9', resolution: '768P' });
  assert.ok(seen.includes('queued'), 'the job shows when it is waiting');

  const asset = c.lib.asset(done.assetId!)!;
  assert.equal(asset.kind, 'video');
  assert.equal(asset.source, 'ai');
  assert.equal(asset.ext, 'mp4');
  assert.equal(asset.scope, 'workspace');
  assert.deepEqual(asset.origin, { provider: 'fal.ai', model: done.modelLabel, prompt: 'A red kite over a beach' });
  assert.ok(existsSync(c.lib.paths.assetOriginal(asset)), 'the file is in the library');
  assert.ok(Math.abs(asset.duration - 4) < 0.1);
  assert.ok(!existsSync(join(c.lib.paths.tmpDir, job.id)), 'temporary files are cleaned up');
});

test('fal: only the trimmed stretch of a clip is uploaded for editing', async () => {
  const c = await setup();
  const clip = await importClip(c, 'clip-a.mp4');
  const key = await modelKey(c, 'fal', 'kling/v4/video-to-video/edit', 'edit-video');
  const count = server.uploads.length;
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'Make it night' }, video: { assetId: clip.id, start: 1, end: 3 } }));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');

  const upload = server.uploads[count];
  assert.equal(upload.type, 'video/mp4');
  const file = join(c.root, 'sent.mp4');
  await writeFile(file, upload.bytes);
  const sent = await runFfprobe(file);
  assert.ok(Math.abs(Number(sent.format?.duration) - 2) < 0.1, `two seconds were sent, not the whole six (${sent.format?.duration})`);
  assert.equal(sent.streams?.find((s) => s.codec_type === 'video')?.codec_name, 'h264');
  const body = server.callsTo('/fal-queue/kling/v4/video-to-video/edit', 'POST').at(-1)!.body as Record<string, unknown>;
  assert.equal(body.video_url, 'https://v3.fal.media/files/test/clip.mp4');
  assert.equal(body.prompt, 'Make it night');
});

test('fal: a talking photo sends a picture and audio to Fabric', async () => {
  const c = await setup();
  const photo = (await c.assets.importFiles([media('photo.jpg')], { scope: 'workspace' })).assets[0];
  const voice = await importClip(c, 'tone.wav');
  const key = await modelKey(c, 'fal', 'veed/fabric-1.0', 'talking-photo');
  const job = await c.jobs.generate({ modelKey: key, choices: { resolution: '720p' }, image: { assetId: photo.id }, audio: { assetId: voice.id }, target: { scope: 'workspace' }, placement: { kind: 'none' } });
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  const body = server.callsTo('/fal-queue/veed/fabric-1.0', 'POST').at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(body, { image_url: 'https://v3.fal.media/files/test/image.jpg', audio_url: 'https://v3.fal.media/files/test/audio.mp3', resolution: '720p' });
});

test('fal: the sound of a video can be used, cut to the chosen stretch', async () => {
  const c = await setup();
  const photo = (await c.assets.importFiles([media('photo.jpg')], { scope: 'workspace' })).assets[0];
  const video = await importClip(c, 'clip-a.mp4');
  const key = await modelKey(c, 'fal', 'veed/fabric-1.0', 'talking-photo');
  const job = await c.jobs.generate({ modelKey: key, choices: { resolution: '720p' }, image: { assetId: photo.id }, audio: { assetId: video.id, start: 1, end: 3 }, target: { scope: 'workspace' }, placement: { kind: 'none' } });
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  const sent = server.uploads.filter((u) => u.name === 'audio.mp3').at(-1)!;
  const file = join(c.root, 'sent.mp3');
  await writeFile(file, sent.bytes);
  const seconds = Number((await runFfprobe(file)).format?.duration);
  assert.ok(Math.abs(seconds - 2) < 0.15, `two seconds were sent, not the whole six (${seconds})`);
});

test('fal: speech comes back as timed text', async () => {
  const c = await setup();
  const cues = await c.jobs.transcribe(media('tone.mp3'));
  assert.deepEqual(cues, [{ start: 0.5, end: 2, text: 'Hello there.' }, { start: 2.2, end: 4, text: 'This line was heard.' }]);
  const body = server.callsTo('/fal-queue/fal-ai/whisper', 'POST').at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(body, { audio_url: 'https://v3.fal.media/files/test/speech.mp3', task: 'transcribe', chunk_level: 'segment' });
});

test('automatic subtitles say which service they need', async () => {
  const c = await setup();
  await c.keys.remove('fal');
  await assert.rejects(c.jobs.transcribe(media('tone.mp3')), /Connect it under AI connections/);
});

test('fal: a still taken from the end of a clip, for extending it', async () => {
  const c = await setup();
  const clip = await importClip(c, 'clip-a.mp4');
  const key = await modelKey(c, 'fal', 'kling/v4/image-to-video', 'image-to-video');
  const count = server.uploads.length;
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'Keep going' }, image: { assetId: clip.id, frameAt: 5.95 } }));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(server.uploads[count].type, 'image/jpeg');
  const body = server.callsTo('/fal-queue/kling/v4/image-to-video', 'POST').at(-1)!.body as Record<string, unknown>;
  assert.equal(body.start_image_url, 'https://v3.fal.media/files/test/frame.jpg', 'Kling names this field differently');
});

test('fal: pictures come back as images', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'fal-ai/flux/schnell', 'text-to-image');
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'A lighthouse' } }));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(c.lib.asset(done.assetId!)?.kind, 'image');
});

test('runway: the version header, model field and upload all follow its protocol', async () => {
  const c = await setup();
  const clip = await importClip(c, 'clip-a.mp4');
  const key = await modelKey(c, 'runway', 'aleph2', 'edit-video');
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'Add falling snow' }, video: { assetId: clip.id, start: 0, end: 2 } }));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');

  const start = server.callsTo('/runway/v1/uploads', 'POST').at(-1)!;
  assert.deepEqual(start.body, { filename: 'clip.mp4', type: 'ephemeral' });
  const sent = server.uploads.at(-1)!;
  assert.match(sent.type, /multipart\/form-data/);
  const text = sent.bytes.toString('latin1');
  assert.ok(text.includes('name="key"') && text.includes('name="policy"') && text.includes('name="file"'), 'the signed fields and the file are sent together');
  assert.ok(text.indexOf('name="key"') < text.indexOf('name="file"'), 'with the file last, as storage services require');

  const body = server.callsTo('/runway/v1/video_to_video', 'POST').at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(body, { model: 'aleph2', promptText: 'Add falling snow', videoUri: 'runway://upload/clip.mp4' });
});

test('runway: moderation failures read as a person would expect', async () => {
  const c = await setup();
  const key = await modelKey(c, 'runway', 'gen4.5', 'text-to-video');
  server.failJobsWith = 'SAFETY.INPUT.TEXT internal detail';
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'x', duration: 5, aspect: '1280:720' } }));
  const done = await finished(c, job.id);
  server.failJobsWith = null;
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /content rules/);
  assert.ok(!done.error!.includes('SAFETY'));
});

test('replicate: models are found by collection and run by name', async () => {
  const c = await setup();
  const models = await c.catalog.models();
  const tasks = models.filter((m) => m.provider === 'replicate').map((m) => `${m.id} ${m.task}`).sort();
  assert.deepEqual(tasks, ['kwaivgi/kling-v4.0 edit-video', 'kwaivgi/kling-v4.0 image-to-video', 'kwaivgi/kling-v4.0 text-to-video', 'veed/fabric-1.0 talking-photo']);
  const m = models.find((x) => x.provider === 'replicate' && x.task === 'image-to-video')!;
  assert.equal(m.image?.field, 'start_image');
  assert.deepEqual(m.aspect?.values, ['16:9', '9:16', '1:1', '21:9'], 'choices hidden behind a reference are still found');

  const clip = await importClip(c, 'logo.png');
  const job = await c.jobs.generate(request(m.key, { choices: { prompt: 'Spin slowly', duration: 5, aspect: '1:1' }, image: { assetId: clip.id } }));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  const body = server.callsTo('/replicate/v1/models/kwaivgi/kling-v4.0/predictions', 'POST').at(-1)!.body as { input: Record<string, unknown> };
  assert.deepEqual(body.input, { prompt: 'Spin slowly', start_image: 'https://api.replicate.com/v1/files/file-1/download', duration: 5, aspect_ratio: '1:1' });
  assert.ok(server.uploads.at(-1)!.bytes.toString('latin1').includes('name="content"'));
});

test('a service refusing a request explains why, and nothing is left running', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  server.refuseSubmit = 422;
  const job = await c.jobs.generate(request(key));
  const done = await finished(c, job.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.error, 'prompt: Prompt was refused');
  assert.equal(done.remote, null);
});

test('running out of credit says so', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  server.refuseSubmit = 402;
  const done = await finished(c, (await c.jobs.generate(request(key))).id);
  assert.equal(done.state, 'failed');
  assert.ok(done.error, 'an explanation is shown');
});

test('a job rides out a bad connection while waiting', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  server.flakyPolls = 5;
  const done = await finished(c, (await c.jobs.generate(request(key))).id);
  assert.equal(done.state, 'done', done.error ?? '');
});

test('cancelling tells the service to stop', async () => {
  const c = await setup();
  const key = await modelKey(c, 'runway', 'gen4.5', 'text-to-video');
  server.pollsToFinish = 1000;
  const job = await c.jobs.generate(request(key, { choices: { prompt: 'x', duration: 5, aspect: '1280:720' } }));
  while (!c.lib.data.aiJobs!.find((j) => j.id === job.id)!.remote) await new Promise((r) => setTimeout(r, 5));
  await c.jobs.cancel(job.id);
  server.pollsToFinish = 2;
  const done = await finished(c, job.id);
  assert.equal(done.state, 'cancelled');
  assert.ok(server.callsTo(`/runway/v1/tasks/${done.remote!.id}`, 'DELETE').length === 1);
});

test('a generation already paid for survives the app closing', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  server.pollsToFinish = 1000;
  const job = await c.jobs.generate(request(key));
  while (!c.lib.data.aiJobs!.find((j) => j.id === job.id)!.remote) await new Promise((r) => setTimeout(r, 5));
  await c.lib.flush();
  c.jobs.shutdown();
  await c.jobs.whenSettled(job.id);
  await c.lib.flush();

  // The next run of the app reads the saved job and finishes it.
  server.pollsToFinish = 2;
  const next = await setup(c.root);
  const saved = next.lib.data.aiJobs!.find((j) => j.id === job.id)!;
  assert.ok(['queued', 'running'].includes(saved.state), saved.state);
  assert.ok(saved.remote?.statusUrl, 'how to reach the job was saved');
  next.jobs.resume();
  const done = await finished(next, job.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.ok(next.lib.asset(done.assetId!));
});

test('a job interrupted before it was sent is reported, not left spinning', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  c.lib.addAiJob({ id: 'job_stale', provider: 'fal', modelKey: key, modelLabel: 'x', task: 'text-to-video', prompt: '', name: 'x', state: 'uploading', queuePosition: null, progress: null, error: null, createdAt: 0, finishedAt: null, remote: null, request: request(key), assetId: null, applied: true });
  c.jobs.resume();
  const stale = c.lib.data.aiJobs!.find((j) => j.id === 'job_stale')!;
  assert.equal(stale.state, 'failed');
  assert.match(stale.error!, /not started/);
});

test('generating needs a connection', async () => {
  const c = await setup();
  const key = await modelKey(c, 'fal', 'minimax/h3-max/text-to-video', 'text-to-video');
  await c.keys.remove('fal');
  await assert.rejects(c.jobs.generate(request(key)), /no longer available|Connect/);
});

test('the job list does not grow without limit', async () => {
  const c = await setup();
  const base = { provider: 'fal' as const, modelKey: 'k', modelLabel: 'x', task: 'text-to-video' as const, prompt: '', name: 'x', state: 'done' as const, queuePosition: null, progress: null, error: null, createdAt: 0, finishedAt: 0, remote: null, request: request('k'), assetId: null, applied: true };
  for (let i = 0; i < 80; i++) c.lib.addAiJob({ ...base, id: `job_${i}` });
  assert.ok(c.lib.data.aiJobs!.length <= 62);
  assert.ok(c.lib.data.aiJobs!.some((j) => j.id === 'job_79'), 'the newest are kept');
});
