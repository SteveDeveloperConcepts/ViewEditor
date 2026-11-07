// Registers every handler behind `window.api`. This is the only place the renderer can reach the main process.

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { API_METHODS, type Api, type AppInfo, type ImportTarget, type PickKind } from '../shared/api.ts';
import { ALL_MEDIA_EXTS, APP_NAME, AUDIO_EXTS, FONT_EXTS, IMAGE_EXTS, VIDEO_EXTS, extOf } from '../shared/constants.ts';
import type { AiProviderStatus } from '../shared/ai.ts';
import { newId } from '../shared/time.ts';
import type { ScriptWriter } from './ai.ts';
import type { AiCatalog } from './ai/catalog.ts';
import type { AiJobs } from './ai/jobs.ts';
import type { KeyStore } from './ai/keys.ts';
import type { AiProvider } from './ai/provider.ts';
import type { AssetManager, ImportOptions } from './assets.ts';
import type { LibraryStore } from './library.ts';
import type { PhoneUpload } from './phone.ts';
import { STOP_SHORTCUT, type Recorder } from './recorder.ts';
import type { RenderJobs } from './renderJobs.ts';
import type { Updater } from './updater.ts';
import { listVoices, speakToFile } from './voice.ts';

export interface Services {
  lib: LibraryStore;
  assets: AssetManager;
  jobs: RenderJobs;
  recorder: Recorder;
  writer: ScriptWriter;
  phone: PhoneUpload;
  aiProviders: AiProvider[];
  aiKeys: KeyStore;
  aiCatalog: AiCatalog;
  aiJobs: AiJobs;
  updater: Updater;
  window: () => BrowserWindow | null;
  /** The renderer has saved its work; the window may go. */
  readyToClose: () => void;
}

type Namespace = keyof typeof API_METHODS;
/** Handlers may answer synchronously; IPC makes every call a promise on the other side anyway. */
type Impl<N extends Namespace> = {
  [K in keyof Api[N]]: Api[N][K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | Promise<R> : never;
};

function register<N extends Namespace>(ns: N, impl: Impl<N>): void {
  for (const name of API_METHODS[ns]) {
    const fn = impl[name] as unknown as (...args: unknown[]) => unknown;
    ipcMain.handle(`${ns}:${String(name)}`, (_event, ...args: unknown[]) => fn(...args));
  }
}

/** Makes a string safe to use as a file name on Windows and macOS. */
function safeFileName(name: string): string {
  const s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  return s || 'video';
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

export function registerIpc(s: Services): void {
  const { lib, assets, jobs, recorder, writer, phone } = s;

  const openDialog = (options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> => {
    const win = s.window();
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  };
  const saveDialog = (options: SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> => {
    const win = s.window();
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
  };

  /** Everything goes into the one Media library, whichever project asked. A project target must still exist. */
  const importOptions = (target: ImportTarget): ImportOptions => {
    if (target?.scope === 'project' && target.projectId) lib.project(target.projectId);
    return { scope: 'workspace' };
  };

  register('app', {
    info: (): AppInfo => ({
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
      libraryPath: lib.paths.root,
      isDev: !app.isPackaged,
      stopRecordingShortcut: STOP_SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    }),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openLibraryFolder: async () => {
      await shell.openPath(lib.paths.root);
    },
    storageUsage: () => folderSize(lib.paths.root),
    pickTextFile: async () => {
      const r = await openDialog({ title: 'Add subtitles', properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      const file = r.filePaths[0];
      if ((await stat(file)).size > 5 * 1024 * 1024) throw new Error('This subtitle file is too large.');
      return { name: file.split(/[\\/]/).pop() ?? 'subtitles', text: await readFile(file, 'utf8') };
    },
    readyToClose: () => s.readyToClose(),
  });

  register('update', {
    state: () => s.updater.state(),
    install: () => {
      // Installing an update and moving the app to Applications both quit it, so they would end an export
      // without the usual warning.
      const kind = s.updater.state()?.kind;
      if ((kind === 'ready' || kind === 'move') && jobs.current()) throw new Error('Wait for the export to finish first.');
      s.updater.install();
    },
  });

  register('library', {
    get: () => lib.data,
    createProject: (input) => lib.createProject(input ?? {}),
    loadProject: (id) => lib.loadProject(id),
    saveProject: (doc) => lib.saveProject(doc),
    renameProject: (id, name) => lib.renameProject(id, name),
    duplicateProject: (id) => lib.duplicateProject(id),
    moveProjects: (ids, spaceId, folderId) => lib.moveProjects(ids, spaceId, folderId),
    trashProjects: (ids) => lib.trashProjects(ids),
    restoreProjects: (ids) => lib.restoreProjects(ids),
    deleteProjectsForever: (ids) => lib.deleteProjectsForever(ids),
    setProjectThumb: (id, data) => lib.setProjectThumb(id, data),
    createSpace: (name) => lib.createSpace(name),
    renameSpace: (id, name) => lib.renameSpace(id, name),
    deleteSpace: (id) => lib.deleteSpace(id),
    createFolder: (spaceId, parentId, name) => lib.createFolder(spaceId, parentId, name),
    renameFolder: (id, name) => lib.renameFolder(id, name),
    deleteFolder: (id) => lib.deleteFolder(id),
    saveAsTemplate: (projectId, name) => lib.saveAsTemplate(projectId, name),
    createFromTemplate: (templateId, opts) => lib.createFromTemplate(templateId, opts ?? {}),
    renameTemplate: (id, name) => lib.renameTemplate(id, name),
    deleteTemplate: (id) => lib.deleteTemplate(id),
    createBrandKit: (name) => lib.createBrandKit(name),
    updateBrandKit: (id, patch) => lib.updateBrandKit(id, patch),
    deleteBrandKit: (id) => lib.deleteBrandKit(id),
    pickBrandFonts: async (kitId) => {
      const r = await openDialog({ title: 'Add fonts', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Fonts', extensions: FONT_EXTS }] });
      if (!r.canceled && r.filePaths.length) await lib.addBrandFonts(kitId, r.filePaths);
    },
    removeBrandFont: (kitId, fontId) => lib.removeBrandFont(kitId, fontId),
    updateSettings: (patch) => {
      // Whether a key is stored is decided here, never by the renderer.
      const { hasApiKey: _ignored, ...rest } = patch ?? {};
      lib.updateSettings(rest);
    },
  });

  const filters: Record<PickKind, { name: string; extensions: string[] }> = {
    media: { name: 'Video, audio and images', extensions: ALL_MEDIA_EXTS },
    video: { name: 'Video', extensions: VIDEO_EXTS },
    audio: { name: 'Audio', extensions: AUDIO_EXTS },
    image: { name: 'Images', extensions: IMAGE_EXTS },
    sound: { name: 'Audio and video', extensions: [...AUDIO_EXTS, ...VIDEO_EXTS] },
  };

  register('assets', {
    pickAndImport: async (kind, target) => {
      const r = await openDialog({ title: 'Add files', properties: ['openFile', 'multiSelections'], filters: [filters[kind] ?? filters.media] });
      if (r.canceled || !r.filePaths.length) return null;
      return assets.importFiles(r.filePaths, importOptions(target));
    },
    importPaths: (paths, target) => assets.importFiles(paths.filter((p) => typeof p === 'string' && p), importOptions(target)),
    importData: async (name, data, target) => {
      const clean = safeFileName(name);
      const dir = join(lib.paths.tmpDir, newId('gen'));
      await mkdir(dir, { recursive: true });
      try {
        const file = join(dir, `data.${extOf(clean) || 'bin'}`);
        await writeFile(file, data);
        return await assets.importFiles([file], { ...importOptions(target), move: true, source: 'generated', names: [clean] });
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
      }
    },
    extractAudio: (id) => assets.extractAudio(id),
    remove: (ids) => assets.remove(ids),
    usage: () => lib.assetUsage(),
    requestProxy: (id) => assets.requestProxy(id),
    markPreviewChecked: (id) => assets.markPreviewChecked(id),
    putImageDerivatives: (id, data) => assets.putImageDerivatives(id, data),
  });

  register('render', {
    begin: async (projectId, kind, suggestedName, format = 'mp4') => {
      let savePath: string | null = null;
      if (kind === 'section') {
        const label = { mp4: 'MP4 video', mp3: 'MP3 audio', gif: 'GIF' }[format];
        if (!label) throw new Error('Unknown format.');
        const r = await saveDialog({
          title: `Save ${format.toUpperCase()}`,
          defaultPath: join(app.getPath('downloads'), `${safeFileName(suggestedName ?? 'export')}.${format}`),
          filters: [{ name: label, extensions: [format] }],
        });
        if (r.canceled || !r.filePath) return null;
        savePath = new RegExp(`\\.${format}$`, 'i').test(r.filePath) ? r.filePath : `${r.filePath}.${format}`;
      }
      return jobs.begin(projectId, kind, savePath, format);
    },
    putOverlay: (jobId, name, data) => jobs.putOverlay(jobId, name, data),
    run: (jobId, payload) => jobs.run(jobId, payload),
    cancel: () => jobs.cancel(),
    current: () => jobs.current(),
    download: async (projectId, format) => {
      const meta = lib.project(projectId);
      const label = { mp4: 'MP4 video', mp3: 'MP3 audio', gif: 'GIF' }[format];
      if (!label) throw new Error('Unknown format.');
      const r = await saveDialog({
        title: `Save ${format.toUpperCase()}`,
        defaultPath: join(app.getPath('downloads'), `${safeFileName(meta.name)}.${format}`),
        filters: [{ name: label, extensions: [format] }],
      });
      if (r.canceled || !r.filePath) return null;
      const target = new RegExp(`\\.${format}$`, 'i').test(r.filePath) ? r.filePath : `${r.filePath}.${format}`;
      await jobs.saveAs(projectId, format, target);
      return target;
    },
    revealExport: (projectId) => {
      const file = jobs.exportPath(projectId);
      if (file) shell.showItemInFolder(file);
    },
    addToMedia: async (projectId) => {
      const file = jobs.exportPath(projectId);
      if (!file) throw new Error('This project has not been exported yet.');
      const result = await assets.importFiles([file], { scope: 'workspace', names: [`${safeFileName(lib.project(projectId).name)}.mp4`] });
      if (!result.assets.length) throw new Error(result.rejected[0]?.reason ?? 'The video could not be added to Media.');
      return result.assets[0];
    },
  });

  register('recorder', {
    sources: () => recorder.listSources(),
    prepare: (sourceId, systemAudio) => recorder.prepare(sourceId, !!systemAudio),
    begin: () => recorder.begin(),
    chunk: (recId, data) => recorder.chunk(recId, data),
    finish: (recId, name, target) => recorder.finish(recId, safeFileName(name), importOptions(target)),
    discard: (recId) => recorder.discard(recId),
    setActive: (active, minimise) => recorder.setActive(!!active, !!minimise),
  });

  register('voice', {
    list: () => listVoices(),
    speak: async ({ sentences, voice, rate, name, target }) => {
      const dir = join(lib.paths.tmpDir, newId('tts'));
      await mkdir(dir, { recursive: true });
      try {
        const { file, timings } = await speakToFile(sentences, voice, rate, dir);
        const result = await assets.importFiles([file], {
          ...importOptions(target), move: true, source: 'voiceover', names: [`${safeFileName(name)}.wav`],
        });
        if (!result.assets.length) throw new Error(result.rejected[0]?.reason ?? 'The voice-over could not be saved.');
        return { asset: result.assets[0], timings };
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
      }
    },
  });

  register('ai', {
    setKey: async (key) => {
      await writer.setKey(key);
      lib.updateSettings({ hasApiKey: writer.hasKey() });
    },
    writeScript: ({ topic, targetSeconds, brief }) => writer.writeScript(String(topic ?? ''), Number(targetSeconds), brief),
    writeScenePrompts: ({ scenes, topic }) => (writer.hasKey() ? writer.writeScenePrompts(scenes, topic) : null),
    providers: async (check) => {
      const status = async (p: AiProvider): Promise<AiProviderStatus> => {
        const key = s.aiKeys.get(p.id);
        const detail = key && check ? await p.verify(key).catch(() => null) : null;
        return { id: p.id, name: p.name, tagline: p.tagline, keyUrl: p.keyUrl, connected: !!key, detail };
      };
      return Promise.all(s.aiProviders.map(status));
    },
    connect: async (id, key) => {
      const p = s.aiProviders.find((x) => x.id === id);
      if (!p) throw new Error('Unknown AI service.');
      const clean = key.trim();
      const detail = await p.verify(clean);
      await s.aiKeys.set(id, clean);
      return { id: p.id, name: p.name, tagline: p.tagline, keyUrl: p.keyUrl, connected: true, detail };
    },
    disconnect: (id) => s.aiKeys.remove(id),
    models: (task, refresh) => s.aiCatalog.models(task, !!refresh),
    price: async (modelKey) => {
      const model = await s.aiCatalog.find(modelKey);
      const p = s.aiProviders.find((x) => x.id === model?.provider);
      const key = model && s.aiKeys.get(model.provider);
      return model && key && p?.price ? p.price(key, model).catch(() => null) : null;
    },
    generate: (request) => s.aiJobs.generate(request),
    transcribe: async (input) => {
      const dir = join(lib.paths.tmpDir, newId('stt'));
      await mkdir(dir, { recursive: true });
      try {
        return await s.aiJobs.transcribe(await jobs.speechFile(input, dir));
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
      }
    },
    cancel: (jobId) => s.aiJobs.cancel(jobId),
    dismiss: (jobId) => s.aiJobs.dismiss(jobId),
    markApplied: (jobId) => s.aiJobs.markApplied(jobId),
  });

  register('phone', {
    start: (target) => phone.start(importOptions(target)),
    stop: () => phone.stop(),
  });
}
