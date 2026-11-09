// The storage layer against a real folder on disk and the real ffmpeg binaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRASH_RETENTION_MS } from '../../src/shared/constants.ts';
import { makeImageItem, makeVideoItem } from '../../src/shared/timeline.ts';
import type { Asset } from '../../src/shared/types.ts';
import { AssetManager } from '../../src/main/assets.ts';
import { LibraryStore } from '../../src/main/library.ts';
import { Paths } from '../../src/main/paths.ts';
import { MEDIA, media, workDir } from './helpers.mts';

async function open(root = workDir('library')): Promise<{ lib: LibraryStore; assets: AssetManager; root: string }> {
  const lib = new LibraryStore(new Paths(root));
  await lib.init();
  return { lib, assets: new AssetManager(lib), root };
}

test('imports every supported format and prepares previews', async () => {
  const { lib, assets } = await open();
  const files = readdirSync(MEDIA).filter((f) => f !== 'subs.srt').map((f) => join(MEDIA, f));
  const progress: number[] = [];
  assets.onImportProgress = (p) => p && progress.push(p.done);
  const result = await assets.importFiles(files, { scope: 'workspace' });
  await assets.whenIdle();

  assert.deepEqual(result.rejected.map((r) => r.name), ['notes.txt'], 'only the text file is refused');
  assert.match(result.rejected[0].reason, /not supported/);
  assert.equal(result.assets.length, files.length - 1);
  assert.equal(progress.length, files.length);

  const byName = Object.fromEntries(lib.data.assets.map((a) => [a.name, a])) as Record<string, Asset>;
  const kind = (k: string): string[] => lib.data.assets.filter((a) => a.kind === k).map((a) => a.name).sort();
  assert.deepEqual(kind('audio'), ['tone.aac', 'tone.flac', 'tone.m4a', 'tone.mp3', 'tone.oga', 'tone.ogg', 'tone.wav']);
  assert.deepEqual(kind('image'), ['exif-rotated.jpg', 'exif-source.jpg', 'logo.png', 'photo.jpg', 'pic.avif', 'pic.webp', 'wide.jpeg']);
  assert.equal(kind('video').length, 18);

  const a = byName['clip-a.mp4'];
  assert.equal(a.width, 1280);
  assert.equal(a.height, 720);
  assert.equal(a.fps, 30);
  assert.ok(Math.abs(a.duration - 6) < 0.05);
  assert.equal(a.hasAudio, true, 'clip-a.mp4 has audio');
  assert.equal(a.audioChannels, 1);
  assert.equal(a.colorMatrix, 'bt709');
  assert.equal(a.proxy, 'none', 'H.264 MP4 plays directly');
  assert.equal(a.previewChecked, true, 'clip-a.mp4 needs no check in the editor');
  assert.equal(byName['portrait.mp4'].width, 720);
  assert.equal(byName['portrait.mp4'].height, 1280);
  assert.equal(byName['fast60.mp4'].fps, 60);
  assert.equal(byName['hdr.mp4'].isHdr, true, 'hdr.mp4 is recognised as HDR');
  assert.equal(byName['logo.png'].hasAlpha, true, 'logo.png keeps its transparency');

  // Posters, filmstrips and waveforms exist for everything that should have them.
  for (const v of lib.data.assets.filter((x) => x.kind === 'video')) {
    assert.ok(v.hasThumb && existsSync(lib.paths.assetThumb(v)), `${v.name} poster`);
    assert.ok(v.strip && v.strip.count >= 1 && existsSync(lib.paths.assetStrip(v.id)), `${v.name} filmstrip`);
  }
  for (const x of lib.data.assets.filter((y) => y.hasAudio)) {
    assert.ok(x.hasWave && existsSync(lib.paths.assetWave(x.id)), `${x.name} waveform`);
  }

  // Formats Chromium cannot play get a proxy straight away; the rest are left for the editor to try.
  for (const name of ['old.avi', 'flash.flv', 'stream.ts', 'theora.ogv', 'prores.mov', 'anim.gif']) {
    const p = byName[name];
    assert.equal(p.proxy, 'ready', `${name} proxy`);
    assert.ok(existsSync(lib.paths.assetProxy(p)), `${name} proxy file`);
  }
  assert.equal(byName['anim.gif'].proxyExt, 'webm', 'GIFs keep their transparency in the preview');
  assert.equal(byName['old.avi'].proxyExt, 'mp4');
  for (const name of ['vp9.webm', 'matroska.mkv', 'phone.m4v', 'alpha.webm']) assert.equal(byName[name].proxy, 'none', name);
  for (const name of ['hevc.mp4', 'hdr.mp4']) {
    assert.equal(byName[name].proxy, 'none');
    assert.equal(byName[name].previewChecked, false, `${name} is tested in the editor first`);
  }

  // The editor can ask for a proxy after the fact.
  assets.requestProxy(byName['hevc.mp4'].id);
  await assets.whenIdle();
  assert.equal(lib.asset(byName['hevc.mp4'].id)!.proxy, 'ready');

  // Folders are refused with a helpful message.
  const folder = await assets.importFiles([MEDIA], { scope: 'workspace' });
  assert.match(folder.rejected[0].reason, /not supported|Folders cannot/);
});

test('projects: create, save, rename, duplicate, move, trash, restore, delete', async () => {
  const { lib, assets, root } = await open();
  const imported = await assets.importFiles([media('clip-a.mp4'), media('logo.png')], { scope: 'project', projectId: null });
  const [clip, logo] = imported.assets;

  const first = await lib.createProject();
  const second = await lib.createProject();
  assert.equal(first.name, 'Untitled video');
  assert.equal(second.name, 'Untitled video 2');
  assert.equal(first.spaceId, lib.defaultSpace.id);

  // Saving a document updates what the dashboard knows about it.
  const doc = await lib.loadProject(first.id);
  lib.updateAsset(clip.id, { projectId: first.id });
  lib.updateAsset(logo.id, { projectId: first.id });
  doc.name = 'Launch video';
  doc.items = [makeVideoItem(clip, doc, doc.tracks[0].id, 0), makeImageItem(logo, doc, doc.tracks[0].id, 6, 2)];
  await lib.saveProject(doc);
  assert.equal(lib.project(first.id).name, 'Launch video');
  assert.ok(Math.abs(lib.project(first.id).duration - 8) < 0.05);
  assert.deepEqual(lib.project(first.id).assetIds.sort(), [clip.id, logo.id].sort());

  await lib.renameProject(first.id, '  Launch   film ');
  assert.equal(lib.project(first.id).name, 'Launch film');
  assert.equal((await lib.loadProject(first.id)).name, 'Launch film');

  const copy = await lib.duplicateProject(first.id);
  assert.equal(copy.name, 'Launch film copy');
  assert.equal((await lib.loadProject(copy.id)).items.length, 2);

  // Spaces and folders.
  const space = lib.createSpace('Marketing');
  const folder = lib.createFolder(space.id, null, 'Q4');
  const sub = lib.createFolder(space.id, folder.id, 'Drafts');
  lib.moveProjects([first.id, copy.id], space.id, sub.id);
  assert.equal(lib.project(first.id).spaceId, space.id);
  assert.equal(lib.project(first.id).folderId, sub.id);
  lib.deleteFolder(folder.id);
  assert.equal(lib.data.folders.length, 0, 'subfolders go with their parent');
  assert.equal(lib.project(first.id).folderId, null, 'projects move up instead of being deleted');
  lib.deleteSpace(space.id);
  assert.equal(lib.project(first.id).spaceId, lib.defaultSpace.id, 'projects of a deleted space move to the default space');
  lib.deleteSpace(lib.defaultSpace.id);
  assert.equal(lib.data.spaces.length, 1, 'the default space cannot be deleted');

  // Trash keeps a project for 30 days.
  lib.trashProjects([first.id]);
  const trashedAt = lib.project(first.id).trashedAt!;
  assert.ok(trashedAt > 0);
  assert.deepEqual(await lib.purgeTrash(trashedAt + TRASH_RETENTION_MS - 1000), [], 'still inside the 30 days');
  lib.restoreProjects([first.id]);
  assert.equal(lib.project(first.id).trashedAt, null);

  // Deleting the original keeps its media while the copy still uses it…
  lib.trashProjects([first.id]);
  assert.deepEqual(await lib.purgeTrash(lib.project(first.id).trashedAt! + TRASH_RETENTION_MS), [first.id], 'removed after 30 days');
  assert.ok(!existsSync(lib.paths.projectFile(first.id)));
  assert.ok(lib.asset(clip.id), 'media still used by the copy survives');
  // …and removes it once nothing refers to it any more.
  await lib.deleteProjectsForever([copy.id]);
  assert.equal(lib.asset(clip.id), undefined);
  assert.ok(!existsSync(lib.paths.assetDir(clip.id)));

  // Everything is on disk: a fresh store sees the same library.
  await lib.flush();
  const again = await open(root);
  assert.deepEqual(again.lib.data.projects.map((p) => p.name), ['Untitled video 2']);
  assert.equal(again.lib.data.spaces.length, 1);
});

test('adopts a project file left without an index entry, but only one named after a project ID', async () => {
  const { lib, root } = await open();
  const project = await lib.createProject();
  const doc = await lib.loadProject(project.id);
  await lib.flush();
  // A project file whose index entry was lost, say in a crash, comes back on the next start…
  writeFileSync(lib.paths.projectFile('prj_0123456789abcdef'), JSON.stringify({ ...doc, id: 'prj_0123456789abcdef', name: 'Recovered' }));
  // …but one named `...json` doesn't: its ID would be '..', and its exports folder the library itself.
  writeFileSync(join(lib.paths.projectsDir, '...json'), JSON.stringify({ ...doc, id: '..', name: 'Odd' }));

  const again = await open(root);
  assert.deepEqual(again.lib.data.projects.map((p) => p.name).sort(), ['Recovered', 'Untitled video']);

  // And one that got into the index some other way can't take the library with it when it is deleted.
  again.lib.data.projects.push({ ...again.lib.project(project.id), id: '..' });
  await again.lib.deleteProjectsForever(['..']);
  assert.ok(existsSync(again.lib.paths.projectFile(project.id)), 'the rest of the library is still there');
  assert.ok(again.lib.project(project.id));
});

test('templates and brand kits', async () => {
  const { lib, assets } = await open();
  const project = await lib.createProject({ name: 'Weekly update' });
  const { assets: [logo] } = await assets.importFiles([media('logo.png')], { scope: 'project', projectId: project.id });
  const doc = await lib.loadProject(project.id);
  doc.items = [makeImageItem(logo, doc, doc.tracks[0].id, 0, 3)];
  await lib.saveProject(doc);

  const tpl = await lib.saveAsTemplate(project.id, 'Weekly layout');
  assert.equal(lib.data.templates.length, 1);
  // The template keeps its media alive even after the source project is gone.
  await lib.deleteProjectsForever([project.id]);
  assert.ok(lib.asset(logo.id), 'template media survives');

  const fromTpl = await lib.createFromTemplate(tpl.id);
  assert.equal(fromTpl.name, 'Weekly layout');
  assert.equal((await lib.loadProject(fromTpl.id)).items.length, 1);
  await lib.deleteProjectsForever([fromTpl.id]);
  await lib.deleteTemplate(tpl.id);
  assert.equal(lib.asset(logo.id), undefined, 'media is cleaned up with the last reference');

  const kit = lib.createBrandKit('Acme');
  const { assets: [mark] } = await assets.importFiles([media('logo.png')], { scope: 'workspace' });
  lib.updateBrandKit(kit.id, { colors: ['#ff0066', 'nonsense', '#00aaff'], logoAssetIds: [mark.id] });
  assert.deepEqual(lib.data.brandKits[0].colors, ['#ff0066', '#00aaff']);
  assert.deepEqual(lib.data.brandKits[0].logoAssetIds, [mark.id]);
  await assets.remove([mark.id]);
  assert.deepEqual(lib.data.brandKits[0].logoAssetIds, [], 'deleted logos leave the kit');
});

test('extracting audio gives a real audio file, once, with the sound of the video', async () => {
  const { assets, lib } = await open();
  const { assets: [video] } = await assets.importFiles([media('clip-a.mp4')], { scope: 'workspace' });
  const sound = await assets.extractAudio(video.id);
  assert.equal(sound.kind, 'audio');
  assert.equal(sound.name, 'clip-a sound.flac');
  assert.ok(Math.abs(sound.duration - video.duration) < 0.1, String(sound.duration));
  assert.equal((await assets.extractAudio(video.id)).id, sound.id, 'asking again gives the same file');
  await assets.whenIdle();
  assert.ok(lib.asset(sound.id)!.hasWave, 'it gets a waveform like any audio');

  const { assets: [picture] } = await assets.importFiles([media('logo.png')], { scope: 'workspace' });
  await assert.rejects(assets.extractAudio(picture.id), /no sound/);
});

test('media from before there was one library joins it', async () => {
  const { lib, assets, root } = await open();
  const project = await lib.createProject({ name: 'Old' });
  await assets.importFiles([media('logo.png')], { scope: 'project', projectId: project.id });
  await lib.flush();
  const again = await open(root);
  assert.equal(again.lib.data.assets[0].scope, 'workspace');
  assert.equal(again.lib.data.assets[0].projectId, null);
});

test('adding the same file again reuses what is in Media', async () => {
  const { lib, assets } = await open();
  const { assets: [first] } = await assets.importFiles([media('clip-a.mp4')], { scope: 'workspace' });
  const { assets: [again] } = await assets.importFiles([media('clip-a.mp4')], { scope: 'workspace' });
  assert.equal(again.id, first.id);
  assert.equal(lib.data.assets.length, 1);
  await assets.importFiles([media('clip-b.mp4')], { scope: 'workspace' });
  assert.equal(lib.data.assets.length, 2, 'a different file is still added');
});
