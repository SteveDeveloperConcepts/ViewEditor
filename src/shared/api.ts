// The contract between the renderer and the main process. The preload script exposes an
// object of this shape as `window.api`; every method is an IPC round trip.

import type { AiJob, AiModel, AiProviderId, AiProviderStatus, AiRequest, AiTask, TimedText } from './ai.ts';
import type { ClipProgress, ClipRequest, ClipResults, ClipSearch, ClipServiceId, ClipServiceStatus } from './clips.ts';
import type { ExportFormat, OutputSpec, TimeWindow } from './render.ts';
import type {
  AppSettings,
  Asset,
  BrandKit,
  CaptureSource,
  Folder,
  ID,
  ImportResult,
  Library,
  ProjectDoc,
  ProjectMeta,
  RenderProgress,
  ScriptBrief,
  ScriptOrigin,
  Space,
  TemplateMeta,
  VoiceInfo,
} from './types.ts';
import type { UpdateState } from './update.ts';

export interface AppInfo {
  name: string;
  version: string;
  platform: 'win32' | 'darwin' | 'linux';
  libraryPath: string;
  isDev: boolean;
  /** Shortcut that stops a recording while the app is in the background. */
  stopRecordingShortcut: string;
}

/** 'sound' is anything with sound in it: audio files, and videos. */
export type PickKind = 'media' | 'video' | 'audio' | 'image' | 'sound';

export interface ImportTarget {
  scope: 'workspace' | 'project';
  projectId?: ID | null;
}

export interface CreateProjectInput {
  name?: string;
  spaceId?: ID | null;
  folderId?: ID | null;
  scriptOrigin?: ScriptOrigin | null;
  doc?: ProjectDoc;
}

export interface SpeechResult {
  asset: Asset;
  /** When each sentence is spoken inside the generated audio, seconds. */
  timings: { start: number; end: number }[];
}

export interface PhoneSession {
  url: string;
  /** QR code for the URL, as an SVG path on a square grid of `size` modules. */
  qr: { size: number; path: string };
}

export interface Api {
  app: {
    info(): Promise<AppInfo>;
    showItemInFolder(path: string): Promise<void>;
    openLibraryFolder(): Promise<void>;
    storageUsage(): Promise<number>;
    pickTextFile(): Promise<{ name: string; text: string } | null>;
    /** Tells the main process the renderer has saved everything and the window may close. */
    readyToClose(): Promise<void>;
  };
  library: {
    get(): Promise<Library>;
    createProject(input?: CreateProjectInput): Promise<ProjectMeta>;
    loadProject(id: ID): Promise<ProjectDoc>;
    saveProject(doc: ProjectDoc): Promise<void>;
    renameProject(id: ID, name: string): Promise<void>;
    duplicateProject(id: ID): Promise<ProjectMeta>;
    moveProjects(ids: ID[], spaceId: ID, folderId: ID | null): Promise<void>;
    trashProjects(ids: ID[]): Promise<void>;
    restoreProjects(ids: ID[]): Promise<void>;
    deleteProjectsForever(ids: ID[]): Promise<void>;
    setProjectThumb(id: ID, data: Uint8Array): Promise<void>;
    createSpace(name: string): Promise<Space>;
    renameSpace(id: ID, name: string): Promise<void>;
    deleteSpace(id: ID): Promise<void>;
    createFolder(spaceId: ID, parentId: ID | null, name: string): Promise<Folder>;
    renameFolder(id: ID, name: string): Promise<void>;
    deleteFolder(id: ID): Promise<void>;
    saveAsTemplate(projectId: ID, name: string): Promise<TemplateMeta>;
    createFromTemplate(templateId: ID, opts?: { spaceId?: ID | null; folderId?: ID | null }): Promise<ProjectMeta>;
    renameTemplate(id: ID, name: string): Promise<void>;
    deleteTemplate(id: ID): Promise<void>;
    createBrandKit(name: string): Promise<BrandKit>;
    updateBrandKit(id: ID, patch: Partial<Pick<BrandKit, 'name' | 'colors' | 'logoAssetIds'>>): Promise<void>;
    deleteBrandKit(id: ID): Promise<void>;
    pickBrandFonts(kitId: ID): Promise<void>;
    removeBrandFont(kitId: ID, fontId: ID): Promise<void>;
    updateSettings(patch: Partial<AppSettings>): Promise<void>;
  };
  assets: {
    /** Opens the system file picker and imports what was chosen. Null when the picker was cancelled. */
    pickAndImport(kind: PickKind, target: ImportTarget): Promise<ImportResult | null>;
    importPaths(paths: string[], target: ImportTarget): Promise<ImportResult>;
    /** Imports media the app produced itself (a generated background, a pasted image). */
    importData(name: string, data: Uint8Array, target: ImportTarget): Promise<ImportResult>;
    /** The sound of a video as an audio file of its own. Asking again gives the same one. */
    extractAudio(id: ID): Promise<Asset>;
    remove(ids: ID[]): Promise<void>;
    usage(): Promise<Record<ID, number>>;
    requestProxy(id: ID): Promise<void>;
    markPreviewChecked(id: ID): Promise<void>;
    putImageDerivatives(id: ID, data: { width: number; height: number; thumb: Uint8Array; raster: Uint8Array | null }): Promise<void>;
  };
  render: {
    /** Starts a job. For a section the user is asked where to save first; null means they cancelled. */
    begin(projectId: ID, kind: 'export' | 'section', suggestedName?: string, format?: ExportFormat): Promise<{ jobId: ID } | null>;
    putOverlay(jobId: ID, name: string, data: Uint8Array): Promise<void>;
    run(jobId: ID, payload: { doc: ProjectDoc; window: TimeWindow; spec: OutputSpec }): Promise<void>;
    cancel(): Promise<void>;
    current(): Promise<RenderProgress | null>;
    /** Saves the project's exported video as MP4, its audio as MP3, or a GIF. Returns the saved path. */
    download(projectId: ID, format: 'mp4' | 'mp3' | 'gif'): Promise<string | null>;
    /** Shows the project's exported file in Explorer or Finder. */
    revealExport(projectId: ID): Promise<void>;
    /** Puts a copy of the project's exported video in Media. */
    addToMedia(projectId: ID): Promise<Asset>;
  };
  recorder: {
    sources(): Promise<CaptureSource[]>;
    /** Chooses what the next screen capture request will record. */
    prepare(sourceId: string, systemAudio: boolean): Promise<void>;
    begin(): Promise<{ recId: ID }>;
    chunk(recId: ID, data: Uint8Array): Promise<void>;
    finish(recId: ID, name: string, target: ImportTarget): Promise<Asset>;
    discard(recId: ID): Promise<void>;
    /** Minimises the window and arms the global stop shortcut while recording; undoes both after. */
    setActive(active: boolean, minimise: boolean): Promise<void>;
  };
  voice: {
    list(): Promise<VoiceInfo[]>;
    speak(input: { sentences: string[]; voice: string; rate: number; name: string; target: ImportTarget }): Promise<SpeechResult>;
  };
  ai: {
    setKey(key: string | null): Promise<void>;
    writeScript(input: { topic: string; targetSeconds: number; brief?: ScriptBrief }): Promise<string>;
    /** Visual prompts for script scenes. Null when Claude is not set up or the attempt did not work. */
    writeScenePrompts(input: { scenes: string[]; topic: string }): Promise<string[] | null>;
    /** The AI video services and whether each is connected. Pass `check` to ask them for account details too. */
    providers(check?: boolean): Promise<AiProviderStatus[]>;
    /** Tests a key against the service and stores it if it works. */
    connect(id: AiProviderId, key: string): Promise<AiProviderStatus>;
    disconnect(id: AiProviderId): Promise<void>;
    /** Models from the connected services. */
    models(task?: AiTask, refresh?: boolean): Promise<AiModel[]>;
    price(modelKey: string): Promise<string | null>;
    generate(request: AiRequest): Promise<AiJob>;
    /** Writes down the speech in a stretch of a project, through a connected service that can. */
    transcribe(input: { doc: ProjectDoc; window: TimeWindow; spec: OutputSpec }): Promise<TimedText[]>;
    cancel(jobId: ID): Promise<void>;
    dismiss(jobId: ID): Promise<void>;
    markApplied(jobId: ID): Promise<void>;
  };
  clips: {
    /** The stock video libraries and whether each is connected. */
    services(): Promise<ClipServiceStatus[]>;
    /** Tests a key against the service and stores it if it works. */
    connect(id: ClipServiceId, key: string): Promise<ClipServiceStatus>;
    disconnect(id: ClipServiceId): Promise<void>;
    search(input: ClipSearch): Promise<ClipResults>;
    /** The clip in Media, downloading it first if it is not there. Null when the download was cancelled. */
    add(request: ClipRequest): Promise<Asset | null>;
    cancel(key: string): Promise<void>;
  };
  phone: {
    start(target: ImportTarget): Promise<PhoneSession>;
    stop(): Promise<void>;
  };
  update: {
    /** What the update notice shows, or null. */
    state(): Promise<UpdateState | null>;
    /**
     * Restarts into a downloaded version, opens the release page of one that has to be fetched by hand, or
     * moves a Mac copy to Applications, which restarts it.
     */
    install(): Promise<void>;
  };
  /** Resolves a dropped File to its path on disk (empty string when it has none). */
  pathForFile(file: File): string;
  on<K extends keyof ApiEvents>(event: K, listener: (payload: ApiEvents[K]) => void): () => void;
}

export interface ApiEvents {
  'library:changed': Library;
  'render:progress': RenderProgress;
  'assets:importing': { done: number; total: number; name: string } | null;
  'recorder:stop': null;
  'phone:received': ImportResult;
  'menu:action': 'undo' | 'redo' | 'selectAll';
  'app:closing': null;
  'update:changed': UpdateState;
  'clips:progress': ClipProgress;
}

type Namespace = Exclude<keyof Api, 'on' | 'pathForFile'>;

/** Method names per namespace. The preload builds `window.api` from this list and the main process registers handlers for it. */
export const API_METHODS: { [N in Namespace]: (keyof Api[N])[] } = {
  app: ['info', 'showItemInFolder', 'openLibraryFolder', 'storageUsage', 'pickTextFile', 'readyToClose'],
  library: [
    'get', 'createProject', 'loadProject', 'saveProject', 'renameProject', 'duplicateProject', 'moveProjects',
    'trashProjects', 'restoreProjects', 'deleteProjectsForever', 'setProjectThumb',
    'createSpace', 'renameSpace', 'deleteSpace', 'createFolder', 'renameFolder', 'deleteFolder',
    'saveAsTemplate', 'createFromTemplate', 'renameTemplate', 'deleteTemplate',
    'createBrandKit', 'updateBrandKit', 'deleteBrandKit', 'pickBrandFonts', 'removeBrandFont', 'updateSettings',
  ],
  assets: ['pickAndImport', 'importPaths', 'importData', 'extractAudio', 'remove', 'usage', 'requestProxy', 'markPreviewChecked', 'putImageDerivatives'],
  render: ['begin', 'putOverlay', 'run', 'cancel', 'current', 'download', 'revealExport', 'addToMedia'],
  recorder: ['sources', 'prepare', 'begin', 'chunk', 'finish', 'discard', 'setActive'],
  voice: ['list', 'speak'],
  ai: ['setKey', 'writeScript', 'writeScenePrompts', 'providers', 'connect', 'disconnect', 'models', 'price', 'generate', 'transcribe', 'cancel', 'dismiss', 'markApplied'],
  clips: ['services', 'connect', 'disconnect', 'search', 'add', 'cancel'],
  phone: ['start', 'stop'],
  update: ['state', 'install'],
};

export const API_EVENTS: (keyof ApiEvents)[] = [
  'library:changed', 'render:progress', 'assets:importing', 'recorder:stop', 'phone:received', 'menu:action', 'app:closing', 'update:changed', 'clips:progress',
];
