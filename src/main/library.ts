// The library: everything the dashboard shows, persisted as one JSON index plus one file per project.
// This module has no Electron dependency so it can be exercised directly in tests.

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isActive, type AiJob } from '../shared/ai.ts';
import { FONT_EXTS, TRASH_RETENTION_MS } from '../shared/constants.ts';
import { newId } from '../shared/time.ts';
import { newProjectDoc, projectDuration, referencedAssetIds } from '../shared/timeline.ts';
import type {
  AppSettings,
  Asset,
  BrandKit,
  ExportInfo,
  Folder,
  ID,
  Library,
  ProjectDoc,
  ProjectMeta,
  ScriptOrigin,
  Space,
  TemplateMeta,
} from '../shared/types.ts';
import { Paths } from './paths.ts';

async function writeAtomic(file: string, text: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function defaultLibrary(): Library {
  const space: Space = { id: newId('spc'), name: 'My Space', createdAt: Date.now(), isDefault: true };
  return {
    version: 1,
    spaces: [space],
    folders: [],
    projects: [],
    templates: [],
    assets: [],
    brandKits: [],
    settings: { workspaceName: 'My Workspace', profileName: '', theme: 'system', hasApiKey: false, claudeCode: false, lastSpaceId: null },
  };
}

function cleanName(name: string, fallback: string): string {
  const s = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  return s || fallback;
}

export interface CreateProjectOptions {
  name?: string;
  spaceId?: ID | null;
  folderId?: ID | null;
  scriptOrigin?: ScriptOrigin | null;
  /** Seed document (from a template or a generator). Its id and name are replaced. */
  doc?: ProjectDoc;
}

export class LibraryStore extends EventEmitter {
  readonly paths: Paths;
  data: Library = defaultLibrary();
  /** Set by the asset manager: stops any background work on the given assets and waits for it to end. */
  beforeAssetRemoval: ((ids: ID[]) => Promise<void>) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(paths: Paths) {
    super();
    this.paths = paths;
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    const p = this.paths;
    for (const dir of [p.root, p.projectsDir, p.templatesDir, p.assetsDir, p.exportsDir, p.brandDir]) {
      await mkdir(dir, { recursive: true });
    }
    await rm(p.tmpDir, { recursive: true, force: true });
    await mkdir(p.tmpDir, { recursive: true });

    const loaded = (await this.read(p.libraryFile)) ?? (await this.read(`${p.libraryFile}.bak`));
    if (loaded) {
      this.data = { ...defaultLibrary(), ...loaded, settings: { ...defaultLibrary().settings, ...loaded.settings } };
      if (!this.data.spaces.length) this.data.spaces = defaultLibrary().spaces;
      if (!this.data.spaces.some((s) => s.isDefault)) this.data.spaces[0].isDefault = true;
      await copyFile(p.libraryFile, `${p.libraryFile}.bak`).catch(() => undefined);
      // Media used to belong to single projects. It all lives in one library now.
      for (const a of this.data.assets) {
        if (a.scope !== 'project') continue;
        a.scope = 'workspace';
        a.projectId = null;
      }
    }
    await this.reconcileProjects();
    await this.purgeTrash();
    // Finish deletions that were blocked last time because a file was still open.
    const pending = this.data.pendingAssetDeletes ?? [];
    const stillBlocked: ID[] = [];
    for (const id of pending) if (!(await this.removeAssetDir(id))) stillBlocked.push(id);
    this.data.pendingAssetDeletes = stillBlocked;
    await this.flush();
  }

  private async read(file: string): Promise<Library | null> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Library;
      return parsed && parsed.version === 1 && Array.isArray(parsed.projects) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Keeps the index and the project files in step: forgets entries without a file, adopts files without an entry. */
  private async reconcileProjects(): Promise<void> {
    const onDisk = new Set((await readdir(this.paths.projectsDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    this.data.projects = this.data.projects.filter((m) => onDisk.has(m.id));
    const known = new Set(this.data.projects.map((m) => m.id));
    for (const id of onDisk) {
      if (known.has(id)) continue;
      try {
        const doc = JSON.parse(await readFile(this.paths.projectFile(id), 'utf8')) as ProjectDoc;
        if (doc?.id !== id || !Array.isArray(doc.items)) continue;
        this.data.projects.push(this.metaFor(doc, this.defaultSpace.id, null, null));
      } catch {
        // Unreadable file: leave it alone rather than guess.
      }
    }
  }

  private changed(): void {
    this.emit('changed', this.data);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 120);
  }

  /** Writes the index now. Writes are serialised so they can never interleave. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const text = JSON.stringify(this.data);
    this.writing = this.writing
      .then(() => writeAtomic(this.paths.libraryFile, text))
      .catch((err) => {
        if (this.listenerCount('error')) this.emit('error', err);
      });
    return this.writing;
  }

  // ------------------------------------------------------------ lookups

  get defaultSpace(): Space {
    return this.data.spaces.find((s) => s.isDefault) ?? this.data.spaces[0];
  }

  project(id: ID): ProjectMeta {
    const m = this.data.projects.find((p) => p.id === id);
    if (!m) throw new Error('This project no longer exists.');
    return m;
  }

  asset(id: ID): Asset | undefined {
    return this.data.assets.find((a) => a.id === id);
  }

  private validSpace(id: ID | null | undefined): ID {
    return id && this.data.spaces.some((s) => s.id === id) ? id : this.defaultSpace.id;
  }

  private validFolder(spaceId: ID, folderId: ID | null | undefined): ID | null {
    return folderId && this.data.folders.some((f) => f.id === folderId && f.spaceId === spaceId) ? folderId : null;
  }

  private uniqueProjectName(base: string): string {
    const taken = new Set(this.data.projects.filter((p) => !p.trashedAt).map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private metaFor(doc: ProjectDoc, spaceId: ID, folderId: ID | null, scriptOrigin: ScriptOrigin | null): ProjectMeta {
    const now = Date.now();
    return {
      id: doc.id, spaceId, folderId, name: doc.name, createdAt: now, updatedAt: now, trashedAt: null,
      duration: projectDuration(doc), width: doc.settings.width, height: doc.settings.height,
      thumbVersion: 0, assetIds: referencedAssetIds(doc), lastExport: null, editedSinceExport: false, scriptOrigin,
    };
  }

  // ------------------------------------------------------------ projects

  async createProject(opts: CreateProjectOptions = {}): Promise<ProjectMeta> {
    const id = newId('prj');
    const name = this.uniqueProjectName(cleanName(opts.name ?? '', 'Untitled video'));
    const doc: ProjectDoc = opts.doc ? { ...opts.doc, id, name } : newProjectDoc(id, name);
    const spaceId = this.validSpace(opts.spaceId);
    const meta = this.metaFor(doc, spaceId, this.validFolder(spaceId, opts.folderId), opts.scriptOrigin ?? null);
    await writeAtomic(this.paths.projectFile(id), JSON.stringify(doc));
    this.data.projects.push(meta);
    this.changed();
    return meta;
  }

  async loadProject(id: ID): Promise<ProjectDoc> {
    this.project(id);
    return JSON.parse(await readFile(this.paths.projectFile(id), 'utf8')) as ProjectDoc;
  }

  /** Autosave target. Also keeps the dashboard's summary of the project current. */
  async saveProject(doc: ProjectDoc): Promise<void> {
    const meta = this.project(doc.id);
    await writeAtomic(this.paths.projectFile(doc.id), JSON.stringify(doc));
    meta.name = cleanName(doc.name, meta.name);
    meta.updatedAt = Date.now();
    meta.duration = projectDuration(doc);
    meta.width = doc.settings.width;
    meta.height = doc.settings.height;
    meta.assetIds = referencedAssetIds(doc);
    if (meta.lastExport) meta.editedSinceExport = true;
    this.changed();
  }

  async renameProject(id: ID, name: string): Promise<void> {
    const meta = this.project(id);
    const next = cleanName(name, meta.name);
    if (next === meta.name) return;
    const doc = await this.loadProject(id);
    doc.name = next;
    await writeAtomic(this.paths.projectFile(id), JSON.stringify(doc));
    meta.name = next;
    meta.updatedAt = Date.now();
    this.changed();
  }

  async duplicateProject(id: ID): Promise<ProjectMeta> {
    const src = this.project(id);
    const doc = await this.loadProject(id);
    const copy = await this.createProject({
      name: `${src.name} copy`, spaceId: src.spaceId, folderId: src.folderId, doc, scriptOrigin: src.scriptOrigin,
    });
    if (src.thumbVersion > 0 && existsSync(this.paths.projectThumb(id))) {
      await copyFile(this.paths.projectThumb(id), this.paths.projectThumb(copy.id));
      copy.thumbVersion = 1;
      this.changed();
    }
    return copy;
  }

  moveProjects(ids: ID[], spaceId: ID, folderId: ID | null): void {
    const space = this.validSpace(spaceId);
    const folder = this.validFolder(space, folderId);
    for (const id of ids) {
      const m = this.data.projects.find((p) => p.id === id);
      if (!m) continue;
      m.spaceId = space;
      m.folderId = folder;
    }
    this.changed();
  }

  trashProjects(ids: ID[]): void {
    const now = Date.now();
    for (const m of this.data.projects) if (ids.includes(m.id) && !m.trashedAt) m.trashedAt = now;
    this.changed();
  }

  restoreProjects(ids: ID[]): void {
    for (const m of this.data.projects) {
      if (!ids.includes(m.id) || !m.trashedAt) continue;
      m.trashedAt = null;
      m.spaceId = this.validSpace(m.spaceId);
      m.folderId = this.validFolder(m.spaceId, m.folderId);
    }
    this.changed();
  }

  /** Permanent: removes the project, its exports and any media only it was using. */
  async deleteProjectsForever(ids: ID[]): Promise<void> {
    const doomed = this.data.projects.filter((p) => ids.includes(p.id));
    if (!doomed.length) return;
    this.data.projects = this.data.projects.filter((p) => !ids.includes(p.id));
    for (const m of doomed) {
      await rm(this.paths.projectFile(m.id), { force: true });
      await rm(this.paths.projectThumb(m.id), { force: true });
      await rm(this.paths.projectExports(m.id), { recursive: true, force: true });
    }
    await this.collectGarbage();
    this.changed();
  }

  /** Projects are kept in Trash for 30 days, then removed for good. */
  async purgeTrash(now = Date.now()): Promise<ID[]> {
    const expired = this.data.projects.filter((p) => p.trashedAt && now - p.trashedAt >= TRASH_RETENTION_MS).map((p) => p.id);
    if (expired.length) await this.deleteProjectsForever(expired);
    return expired;
  }

  async setProjectThumb(id: ID, data: Uint8Array): Promise<void> {
    const meta = this.project(id);
    await writeAtomic(this.paths.projectThumb(id), data);
    meta.thumbVersion += 1;
    this.changed();
  }

  setLastExport(id: ID, info: ExportInfo): void {
    const meta = this.project(id);
    meta.lastExport = info;
    meta.editedSinceExport = false;
    this.changed();
  }

  // ------------------------------------------------------------ spaces and folders

  createSpace(name: string): Space {
    const space: Space = { id: newId('spc'), name: cleanName(name, 'New space'), createdAt: Date.now(), isDefault: false };
    this.data.spaces.push(space);
    this.changed();
    return space;
  }

  renameSpace(id: ID, name: string): void {
    const s = this.data.spaces.find((x) => x.id === id);
    if (!s) return;
    s.name = cleanName(name, s.name);
    this.changed();
  }

  /** Deleting a space never deletes work: its projects move to the default space. */
  deleteSpace(id: ID): void {
    const s = this.data.spaces.find((x) => x.id === id);
    if (!s || s.isDefault) return;
    const home = this.defaultSpace.id;
    for (const p of this.data.projects) {
      if (p.spaceId === id) {
        p.spaceId = home;
        p.folderId = null;
      }
    }
    this.data.folders = this.data.folders.filter((f) => f.spaceId !== id);
    this.data.spaces = this.data.spaces.filter((x) => x.id !== id);
    if (this.data.settings.lastSpaceId === id) this.data.settings.lastSpaceId = null;
    this.changed();
  }

  createFolder(spaceId: ID, parentId: ID | null, name: string): Folder {
    const space = this.validSpace(spaceId);
    const folder: Folder = {
      id: newId('fld'), spaceId: space, parentId: this.validFolder(space, parentId), name: cleanName(name, 'New folder'), createdAt: Date.now(),
    };
    this.data.folders.push(folder);
    this.changed();
    return folder;
  }

  renameFolder(id: ID, name: string): void {
    const f = this.data.folders.find((x) => x.id === id);
    if (!f) return;
    f.name = cleanName(name, f.name);
    this.changed();
  }

  /** Deleting a folder moves the projects inside it (and inside its subfolders) up one level. */
  deleteFolder(id: ID): void {
    const target = this.data.folders.find((x) => x.id === id);
    if (!target) return;
    const doomed = new Set<ID>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of this.data.folders) {
        if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    for (const p of this.data.projects) if (p.folderId && doomed.has(p.folderId)) p.folderId = target.parentId;
    this.data.folders = this.data.folders.filter((f) => !doomed.has(f.id));
    this.changed();
  }

  // ------------------------------------------------------------ templates

  async saveAsTemplate(projectId: ID, name: string): Promise<TemplateMeta> {
    const src = this.project(projectId);
    const doc = await this.loadProject(projectId);
    const id = newId('tpl');
    const tplName = cleanName(name, src.name);
    await writeAtomic(this.paths.templateFile(id), JSON.stringify({ ...doc, id, name: tplName }));
    const meta: TemplateMeta = {
      id, name: tplName, createdAt: Date.now(), duration: projectDuration(doc),
      width: doc.settings.width, height: doc.settings.height, thumbVersion: 0, assetIds: referencedAssetIds(doc),
    };
    if (src.thumbVersion > 0 && existsSync(this.paths.projectThumb(projectId))) {
      await copyFile(this.paths.projectThumb(projectId), this.paths.templateThumb(id));
      meta.thumbVersion = 1;
    }
    this.data.templates.push(meta);
    this.changed();
    return meta;
  }

  async createFromTemplate(templateId: ID, opts: { spaceId?: ID | null; folderId?: ID | null } = {}): Promise<ProjectMeta> {
    const tpl = this.data.templates.find((t) => t.id === templateId);
    if (!tpl) throw new Error('This template no longer exists.');
    const doc = JSON.parse(await readFile(this.paths.templateFile(templateId), 'utf8')) as ProjectDoc;
    const meta = await this.createProject({ name: tpl.name, spaceId: opts.spaceId, folderId: opts.folderId, doc });
    if (tpl.thumbVersion > 0 && existsSync(this.paths.templateThumb(templateId))) {
      await copyFile(this.paths.templateThumb(templateId), this.paths.projectThumb(meta.id));
      meta.thumbVersion = 1;
      this.changed();
    }
    return meta;
  }

  renameTemplate(id: ID, name: string): void {
    const t = this.data.templates.find((x) => x.id === id);
    if (!t) return;
    t.name = cleanName(name, t.name);
    this.changed();
  }

  async deleteTemplate(id: ID): Promise<void> {
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    await rm(this.paths.templateFile(id), { force: true });
    await rm(this.paths.templateThumb(id), { force: true });
    await this.collectGarbage();
    this.changed();
  }

  // ------------------------------------------------------------ brand kits

  createBrandKit(name: string): BrandKit {
    const kit: BrandKit = { id: newId('brd'), name: cleanName(name, 'Brand kit'), createdAt: Date.now(), colors: [], logoAssetIds: [], fonts: [] };
    this.data.brandKits.push(kit);
    this.changed();
    return kit;
  }

  updateBrandKit(id: ID, patch: Partial<Pick<BrandKit, 'name' | 'colors' | 'logoAssetIds'>>): void {
    const kit = this.data.brandKits.find((k) => k.id === id);
    if (!kit) return;
    if (patch.name !== undefined) kit.name = cleanName(patch.name, kit.name);
    if (patch.colors) kit.colors = patch.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 24);
    if (patch.logoAssetIds) kit.logoAssetIds = patch.logoAssetIds.filter((a) => this.asset(a)?.kind === 'image');
    this.changed();
  }

  async deleteBrandKit(id: ID): Promise<void> {
    this.data.brandKits = this.data.brandKits.filter((k) => k.id !== id);
    await rm(this.paths.brandKitDir(id), { recursive: true, force: true });
    this.changed();
  }

  async addBrandFonts(kitId: ID, files: string[]): Promise<void> {
    const kit = this.data.brandKits.find((k) => k.id === kitId);
    if (!kit) return;
    await mkdir(this.paths.brandKitDir(kitId), { recursive: true });
    for (const file of files) {
      const ext = extname(file).slice(1).toLowerCase();
      if (!FONT_EXTS.includes(ext)) continue;
      const id = newId('fnt');
      const stored = `${id}.${ext}`;
      await copyFile(file, join(this.paths.brandKitDir(kitId), stored));
      const family = basename(file, extname(file)).replace(/[^\w \-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Brand font';
      kit.fonts.push({ id, family, file: stored });
    }
    this.changed();
  }

  async removeBrandFont(kitId: ID, fontId: ID): Promise<void> {
    const kit = this.data.brandKits.find((k) => k.id === kitId);
    const font = kit?.fonts.find((f) => f.id === fontId);
    if (!kit || !font) return;
    kit.fonts = kit.fonts.filter((f) => f.id !== fontId);
    await rm(join(this.paths.brandKitDir(kitId), font.file), { force: true });
    this.changed();
  }

  // ------------------------------------------------------------ settings

  updateSettings(patch: Partial<AppSettings>): void {
    const s = this.data.settings;
    if (patch.workspaceName !== undefined) s.workspaceName = cleanName(patch.workspaceName, s.workspaceName);
    if (patch.profileName !== undefined) s.profileName = patch.profileName.trim().slice(0, 80);
    if (patch.theme === 'system' || patch.theme === 'light' || patch.theme === 'dark') s.theme = patch.theme;
    if (patch.hasApiKey !== undefined) s.hasApiKey = patch.hasApiKey;
    if (patch.claudeCode !== undefined) s.claudeCode = patch.claudeCode;
    if (patch.lastSpaceId !== undefined) s.lastSpaceId = patch.lastSpaceId;
    this.changed();
  }

  // ------------------------------------------------------------ AI jobs

  addAiJob(job: AiJob): void {
    const jobs = [...(this.data.aiJobs ?? []), job];
    // Finished jobs are only a history: keep the recent ones.
    const finished = jobs.filter((j) => !isActive(j) && j.applied);
    const dropped = new Set(finished.slice(0, Math.max(0, finished.length - 60)).map((j) => j.id));
    this.data.aiJobs = jobs.filter((j) => !dropped.has(j.id));
    this.changed();
  }

  updateAiJob(id: ID, patch: Partial<AiJob>): void {
    const job = this.data.aiJobs?.find((j) => j.id === id);
    if (!job) return;
    Object.assign(job, patch);
    this.changed();
  }

  removeAiJob(id: ID): void {
    this.data.aiJobs = (this.data.aiJobs ?? []).filter((j) => j.id !== id);
    this.changed();
  }

  // ------------------------------------------------------------ assets (index only; files are handled by AssetManager)

  addAsset(asset: Asset): void {
    this.data.assets.push(asset);
    this.changed();
  }

  updateAsset(id: ID, patch: Partial<Asset>): Asset | undefined {
    const a = this.asset(id);
    if (!a) return undefined;
    Object.assign(a, patch);
    this.changed();
    return a;
  }

  async removeAssets(ids: ID[]): Promise<void> {
    const set = new Set(ids);
    this.data.assets = this.data.assets.filter((a) => !set.has(a.id));
    for (const kit of this.data.brandKits) kit.logoAssetIds = kit.logoAssetIds.filter((id) => !set.has(id));
    this.changed();
    // Background jobs may still be reading these files; they have to stop before the files can go.
    await this.beforeAssetRemoval?.(ids);
    for (const id of ids) {
      if (!(await this.removeAssetDir(id))) (this.data.pendingAssetDeletes ??= []).push(id);
    }
    this.changed();
  }

  private async removeAssetDir(id: ID): Promise<boolean> {
    try {
      await rm(this.paths.assetDir(id), { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
      return true;
    } catch {
      return false;
    }
  }

  /** How many live projects use each asset. */
  assetUsage(): Record<ID, number> {
    const usage: Record<ID, number> = {};
    for (const p of this.data.projects) for (const id of p.assetIds) usage[id] = (usage[id] ?? 0) + 1;
    return usage;
  }

  /**
   * Removes project-owned media that nothing can reach any more: its project is gone
   * and no other project, template or brand kit refers to it.
   */
  async collectGarbage(): Promise<void> {
    const projects = new Set(this.data.projects.map((p) => p.id));
    const referenced = new Set<ID>();
    for (const p of this.data.projects) for (const id of p.assetIds) referenced.add(id);
    for (const t of this.data.templates) for (const id of t.assetIds) referenced.add(id);
    for (const k of this.data.brandKits) for (const id of k.logoAssetIds) referenced.add(id);
    const orphans = this.data.assets
      .filter((a) => a.scope === 'project' && !referenced.has(a.id) && !(a.projectId && projects.has(a.projectId)))
      .map((a) => a.id);
    if (orphans.length) await this.removeAssets(orphans);
  }
}
