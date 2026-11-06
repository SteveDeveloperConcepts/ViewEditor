// Reading real model schemas. The fixtures are entries saved from the services' live catalogues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aspectLabel,
  buildInputs,
  durationChoices,
  durationLabel,
  durationSeconds,
  missingInput,
  modelsFromSchema,
  pickAspect,
  pickDuration,
  planScenes,
  ratioOf,
  refResolver,
  type AiHint,
  type AiModel,
  type AiOption,
} from '../../src/shared/ai.ts';
import { modelsFromCatalog } from '../../src/main/ai/fal.ts';
import { findMediaUrls } from '../../src/main/ai/provider.ts';
import { modelsFromSpec } from '../../src/main/ai/runway.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ai');
const falEntries = JSON.parse(readFileSync(join(dir, 'fal-models.json'), 'utf8')) as { endpoint_id: string; metadata?: { category?: string } }[];
const runwaySpec = JSON.parse(readFileSync(join(dir, 'runway-openapi.json'), 'utf8'));

const hintFor = (category: string | undefined): AiHint => (category === 'text-to-image' || category === 'text-to-video' || category === 'image-to-video' ? category : 'video-to-video');
const fal: AiModel[] = falEntries.flatMap((m) => modelsFromCatalog([m as never], hintFor(m.metadata?.category)));
const runway = modelsFromSpec(runwaySpec);

const falModel = (id: string): AiModel[] => fal.filter((m) => m.id === id);
const runwayModel = (id: string, task: AiModel['task']): AiModel => runway.find((m) => m.id === id && m.task === task)!;

test('fal: models are sorted by what they can do', () => {
  const task = (id: string): string[] => falModel(id).map((m) => m.task);
  assert.deepEqual(task('minimax/h3-max/text-to-video'), ['text-to-video']);
  assert.deepEqual(task('kling/v4/image-to-video'), ['image-to-video']);
  assert.deepEqual(task('kling/v4/video-to-video/edit'), ['edit-video']);
  assert.deepEqual(task('google/gemini-omni-flash/v1.1/edit'), ['edit-video']);
  assert.deepEqual(task('veed/fabric-1.0'), ['talking-photo']);
  assert.deepEqual(task('fal-ai/bytedance/omnihuman/v1.5'), ['talking-photo']);
  assert.deepEqual(task('fal-ai/sync-lipsync/v3'), ['lip-sync']);
  assert.deepEqual(task('veed/lipsync'), ['lip-sync']);
  assert.deepEqual(task('fal-ai/flux/schnell'), ['text-to-image']);
});

test('fal: pipeline tools are not offered as models', () => {
  for (const id of ['fal-ai/ffmpeg-api/merge-audio-video', 'topaz/upscale/video/precision', 'fal-ai/sam-3/video', 'fal-ai/mmaudio-v2']) {
    assert.deepEqual(falModel(id), [], id);
  }
});

test('fal: a model needing an input the form cannot send is not offered for that task', () => {
  // Recast swaps a character using reference images, which "edit a video" has no way to supply.
  assert.ok(!falModel('minimax/h3-max/recast').some((m) => m.task === 'edit-video'));
});

test('fal: fields are read from the schema, not assumed', () => {
  const kling = falModel('kling/v4/image-to-video')[0];
  assert.equal(kling.image?.field, 'start_image_url', 'Kling names its first frame differently from most');
  assert.equal(kling.image?.required, true);
  const older = falModel('fal-ai/kling-video/v2.5-turbo/pro/image-to-video')[0];
  assert.equal(older.image?.field, 'image_url');
  assert.deepEqual(older.duration?.values, ['5', '10'], 'durations stay strings when the model wants strings');
  const fabric = falModel('veed/fabric-1.0')[0];
  assert.equal(fabric.prompt, null, 'Fabric takes no prompt');
  assert.equal(fabric.audio?.field, 'audio_url');
  assert.deepEqual([...fabric.resolution!.values!].sort(), ['480p', '720p']);
});

test('fal: required settings with a default are sent even though nobody is asked', () => {
  const m = falModel('minimax/h3-max/text-to-video')[0];
  assert.equal(m.fixed.prompt_expansion_mode, 'balanced');
  assert.equal(buildInputs(m, { prompt: 'x' }, {}).prompt_expansion_mode, 'balanced');
});

test('runway: every model of each endpoint is read from the spec', () => {
  assert.ok(runway.filter((m) => m.task === 'text-to-video').length >= 20);
  assert.ok(runway.filter((m) => m.task === 'image-to-video').length >= 20);
  assert.ok(runway.filter((m) => m.task === 'edit-video').length >= 8);
  const gen = runwayModel('gen4.5', 'text-to-video');
  assert.equal(gen.endpoint, '/v1/text_to_video');
  assert.equal(gen.fixed.model, 'gen4.5', 'the model name is part of the request body');
  assert.equal(gen.prompt?.field, 'promptText');
  assert.deepEqual([gen.duration?.min, gen.duration?.max], [2, 10]);
  assert.deepEqual(gen.aspect?.values, ['1280:720', '720:1280']);
  assert.deepEqual(runwayModel('veo3.1', 'text-to-video').duration?.values, [4, 6, 8]);
});

test('runway: the same model takes different fields on different endpoints', () => {
  assert.equal(runwayModel('gen4.5', 'image-to-video').image?.field, 'promptImage');
  assert.equal(runwayModel('aleph2', 'edit-video').video?.field, 'videoUri');
  assert.equal(runwayModel('seedance2', 'edit-video').video?.field, 'promptVideo');
});

test('runway: edit modes keep the shape and length of the input video', () => {
  const m = runwayModel('seedance2_5', 'edit-video');
  assert.equal(m.fixed.mode, 'edit');
  assert.equal(m.fixed.duration, 'auto');
  assert.equal(m.aspect, null, 'ratio is rejected in this mode');
  const body = buildInputs(m, { prompt: 'Change the jacket to red leather', aspect: '1280:720' }, { video: 'runway://v' });
  assert.deepEqual(body, { model: 'seedance2_5', mode: 'edit', duration: 'auto', promptText: 'Change the jacket to red leather', promptVideo: 'runway://v' });
});

test('resolutions that differ only by case are offered once', () => {
  const values = runwayModel('hailuo3', 'text-to-video').resolution!.values!;
  assert.equal(new Set(values.map((v) => String(v).toLowerCase())).size, values.length);
});

test('lists of files get a list', () => {
  const schema = { type: 'object', required: ['prompt', 'image_urls'], properties: { prompt: { type: 'string' }, image_urls: { type: 'array', items: { type: 'string' } } } };
  const [m] = modelsFromSchema(schema, refResolver(schema), { provider: 'fal', id: 'x/y', endpoint: 'x/y', label: 'X', description: '', hint: 'image-to-video' });
  assert.deepEqual(buildInputs(m, { prompt: 'p' }, { image: 'u' }).image_urls, ['u']);
});

test('a required setting the app cannot fill in rules a model out', () => {
  const schema = { type: 'object', required: ['prompt', 'mystery'], properties: { prompt: { type: 'string' }, mystery: { type: 'string' } } };
  assert.deepEqual(modelsFromSchema(schema, refResolver(schema), { provider: 'fal', id: 'x', endpoint: 'x', label: 'X', description: '', hint: 'text-to-video' }), []);
});

test('an on/off audio setting is not mistaken for an audio file', () => {
  const schema = { type: 'object', required: ['prompt', 'start_image_url'], properties: { prompt: { type: 'string' }, start_image_url: { type: 'string' }, audio: { type: 'boolean', default: true } } };
  const [m] = modelsFromSchema(schema, refResolver(schema), { provider: 'fal', id: 'x', endpoint: 'x', label: 'X', description: '', hint: 'image-to-video' });
  assert.equal(m.task, 'image-to-video');
  assert.equal(m.audio, null);
  assert.deepEqual(m.sound, { field: 'audio', default: true });
});

const range = (min: number, max: number, def: number | null = null): AiOption => ({ field: 'duration', values: null, min, max, default: def, required: false });
const list = (values: (string | number)[]): AiOption => ({ field: 'duration', values, min: null, max: null, default: null, required: false });

test('durations are chosen from what the model allows', () => {
  assert.deepEqual(durationChoices(range(2, 10)), [2, 3, 4, 5, 6, 8, 10]);
  assert.deepEqual(durationChoices(range(0.92, 15)), [1, 3, 4, 5, 6, 8, 10, 12, 15]);
  assert.deepEqual(durationChoices(range(2, 10, 7)), [2, 3, 4, 5, 6, 7, 8, 10], 'the default is always among the choices');
  assert.equal(pickDuration(list([4, 6, 8]), 5.2), 6, 'the shortest that covers it');
  assert.equal(pickDuration(list([4, 6, 8]), 30), 8, 'or the longest available');
  assert.equal(pickDuration(list(['5', '10']), 7), '10', 'keeping the type the model uses');
  assert.equal(pickDuration(list(['auto', '5s', '10s']), 7), '10s');
  assert.equal(pickDuration(null, 7), undefined);
  assert.equal(durationSeconds('5s'), 5);
  assert.equal(durationSeconds('auto'), null);
  assert.equal(durationLabel('auto'), 'Automatic');
  assert.equal(durationLabel('5'), '5 s');
});

test('the closest shape is picked for the frame', () => {
  const shapes: AiOption = { field: 'ratio', values: ['1280:720', '720:1280', '960:960', '1920:1080'], min: null, max: null, default: null, required: false };
  assert.equal(pickAspect(shapes, 1920, 1080), '1920:1080', 'same shape, sharper frame');
  assert.equal(pickAspect(shapes, 1080, 1920), '720:1280');
  assert.equal(pickAspect(shapes, 1080, 1080), '960:960');
  assert.equal(pickAspect(shapes, 1080, 1350), '960:960', '4:5 is nearest to square here');
  const words: AiOption = { ...shapes, values: ['auto_720p', 'auto_1080p'], default: 'auto_720p' };
  assert.equal(pickAspect(words, 1920, 1080), 'auto_720p', 'with nothing to compare, the default');
  assert.equal(ratioOf('auto'), null);
});

test('shapes read well', () => {
  assert.equal(aspectLabel('16:9'), '16:9');
  assert.equal(aspectLabel('1280:720'), '16:9 · 1280 × 720');
  assert.equal(aspectLabel('960:960'), '1:1 · 960 × 960');
  assert.equal(aspectLabel('auto'), 'Match the input');
  assert.equal(aspectLabel('adaptive'), 'Match the input');
});

test('a request only carries what the model takes, with values it accepts', () => {
  const m = runwayModel('veo3.1', 'text-to-video');
  const body = buildInputs(m, { prompt: '  a cat  ', duration: 7, aspect: 'nonsense', sound: true }, { image: 'ignored' });
  assert.deepEqual(body, { model: 'veo3.1', promptText: 'a cat', duration: 4, ratio: '1280:720', audio: true }, 'bad values fall back and unknown inputs are dropped');
  const gen = runwayModel('gen4.5', 'text-to-video');
  assert.equal(buildInputs(gen, { prompt: 'x', duration: 99 }, {}).duration, 10, 'ranges are clamped');
  assert.ok('ratio' in buildInputs(gen, { prompt: 'x' }, {}), 'required settings are always sent');
});

test('prompts are cut to the length the model allows', () => {
  const m = runwayModel('gen4.5', 'text-to-video');
  assert.equal(m.prompt?.maxLength, 1000);
  assert.equal((buildInputs(m, { prompt: 'x'.repeat(5000) }, {}).promptText as string).length, 1000);
});

test('the form knows what is still missing', () => {
  const t2v = runwayModel('gen4.5', 'text-to-video');
  assert.match(missingInput(t2v, {}, { image: false, video: false, audio: false })!, /Describe/);
  assert.equal(missingInput(t2v, { prompt: 'x' }, { image: false, video: false, audio: false }), null);
  const fabric = falModel('veed/fabric-1.0')[0];
  assert.match(missingInput(fabric, {}, { image: false, video: false, audio: true })!, /image/);
  assert.match(missingInput(fabric, {}, { image: true, video: false, audio: false })!, /audio/);
  assert.equal(missingInput(fabric, {}, { image: true, video: false, audio: true }), null);
  const optional = falModel('fal-ai/kling-video/v3/pro/text-to-video')[0];
  assert.equal(optional.prompt?.required, false);
  assert.match(missingInput(optional, {}, { image: false, video: false, audio: false })!, /Describe/, 'text to video always needs words');
});

test('results are found however a model shapes them', () => {
  assert.deepEqual(findMediaUrls({ video: { url: 'https://a/v.mp4' }, seed: 3 }), ['https://a/v.mp4']);
  assert.deepEqual(findMediaUrls({ images: [{ url: 'https://a/1.png' }, { url: 'https://a/2.png' }] }), ['https://a/1.png', 'https://a/2.png']);
  assert.deepEqual(findMediaUrls('https://a/v.mp4'), ['https://a/v.mp4']);
  assert.deepEqual(findMediaUrls(['https://a/v.mp4']), ['https://a/v.mp4']);
  assert.deepEqual(findMediaUrls({ video_url: 'https://a/v.mp4' }), ['https://a/v.mp4']);
  assert.deepEqual(findMediaUrls({ timings: { inference: 3 } }), []);
});

test('narration is grouped into scenes that leave no gaps', () => {
  const timings = [
    { start: 0, end: 2 },
    { start: 2.3, end: 4 },
    { start: 4.3, end: 9 },
    { start: 9.3, end: 11 },
    { start: 11.3, end: 12 },
  ];
  const scenes = planScenes(timings, 5);
  assert.deepEqual(scenes.map((s) => s.sentences), [[0, 1], [2], [3, 4]]);
  assert.equal(scenes[0].start, 0);
  scenes.forEach((s, i) => i && assert.equal(s.start, scenes[i - 1].end, 'each scene starts where the last ended'));
  assert.equal(scenes.at(-1)!.end, 12);
  assert.deepEqual(planScenes([], 5), []);
});
