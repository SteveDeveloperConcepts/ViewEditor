import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  Check,
  CircleAlert,
  Clapperboard,
  Group,
  Image as ImageIcon,
  Music,
  Palette,
  Redo2,
  Settings,
  Smartphone,
  Sparkles,
  Speech,
  Type,
  Undo2,
  Ungroup,
  Upload,
  Video,
} from 'lucide-react';
import { isActive } from '@shared/ai';
import { projectDuration } from '@shared/timeline';
import type { ID } from '@shared/types';
import { forgetDrafts } from '@/ai/drafts';
import { Modal } from '@/components/Modal';
import { Button, IconButton, Spinner } from '@/components/ui';
import { api, errorMessage, isMod, isTyping, MOD_LABEL } from '@/lib/api';
import { startRender } from '@/lib/exporter';
import { loadBrandFonts } from '@/lib/fonts';
import { updateProjectThumb } from '@/lib/thumbnail';
import { openRecorder } from '@/recorder/openRecorder';
import {
  clearSelection,
  closeProject,
  copySelection,
  deleteSelection,
  duplicateSelection,
  flushSave,
  groupSelection,
  openProject,
  paste,
  redo,
  renameProject,
  selectAll,
  selectionHasGroup,
  setPanel,
  setZoom,
  splitAtPlayhead,
  undo,
  ungroupSelection,
  useEditor,
  type PanelId,
} from '@/store/editor';
import { isRendering, useLibrary } from '@/store/library';
import { usePrefs } from '@/store/prefs';
import { navigate, onLeave, showModal, toast } from '@/store/ui';
import { droppedPaths, hasFiles, importPathsIntoProject, pickIntoProject, SUPPORTED_SUMMARY } from './importing';
import { AiPanel } from './panels/AiPanel';
import { BrandPanel } from './panels/BrandPanel';
import { Inspector } from './panels/Inspector';
import { MediaPanel } from './panels/MediaPanel';
import { SettingsPanel, SizeSelect } from './panels/SettingsPanel';
import { openSpeechDialog } from './panels/SpeechDialog';
import { SubtitlesPanel } from './panels/SubtitlesPanel';
import { TextPanel } from './panels/TextPanel';
import { openPhoneDialog } from './PhoneDialog';
import { pause, seek, stepFrames, togglePlay } from './player';
import { Stage } from './Stage';
import { Timeline, TimelineResizer } from './Timeline';

const RAIL: { id: PanelId; label: string; icon: ReactNode }[] = [
  { id: 'ai', label: 'AI tools', icon: <Sparkles size={18} /> },
  { id: 'video', label: 'Video', icon: <Video size={18} /> },
  { id: 'audio', label: 'Audio', icon: <Music size={18} /> },
  { id: 'image', label: 'Image', icon: <ImageIcon size={18} /> },
  { id: 'subtitles', label: 'Subtitles', icon: <Captions size={18} /> },
  { id: 'text', label: 'Text', icon: <Type size={18} /> },
  { id: 'brand', label: 'Brand Kit', icon: <Palette size={18} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={18} /> },
];

function SaveState(): ReactNode {
  const state = useEditor((s) => s.saveState);
  if (state === 'error') {
    return (
      <span className="save-state error" title="Changes could not be saved">
        <CircleAlert size={13} /> Not saved
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="save-state" title="Projects save automatically">
        <Check size={13} /> Saved
      </span>
    );
  }
  return <span className="save-state">Saving…</span>;
}

function ProjectName(): ReactNode {
  const name = useEditor((s) => s.doc?.name ?? '');
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  return (
    <input
      className="project-name"
      aria-label="Project name"
      value={text}
      maxLength={120}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (text.trim()) renameProject(text);
        else setText(name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function TopBar({ projectId, onDone, exporting }: { projectId: ID; onDone: () => void; exporting: boolean }): ReactNode {
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const empty = useEditor((s) => (s.doc ? projectDuration(s.doc) <= 0 : true));
  return (
    <header className="editor-top">
      <IconButton label="Back to Projects" onClick={() => void navigate({ page: 'library', view: { kind: 'all' } })}>
        <ArrowLeft size={17} />
      </IconButton>
      <ProjectName />
      <SaveState />
      <div className="divider-v" />
      <IconButton label={`Undo (${MOD_LABEL}+Z)`} disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label={`Redo (${MOD_LABEL}+Shift+Z)`} disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </IconButton>
      <div className="grow" />
      <Button variant="ghost" icon={<Clapperboard size={15} />} onClick={() => void openRecorder({ projectId, addToTimeline: true })}>
        Record
      </Button>
      <Button variant="primary" icon={exporting ? <Spinner /> : <Check size={15} />} disabled={empty || exporting} title={empty ? 'Add something to the timeline first' : 'Export this project'} onClick={onDone}>
        Done
      </Button>
    </header>
  );
}

function StageBar(): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  return (
    <div className="stage-bar">
      {selection.length > 1 && !selectionHasGroup(doc, selection) && (
        <Button size="small" icon={<Group size={13} />} onClick={groupSelection}>
          Group
        </Button>
      )}
      {selectionHasGroup(doc, selection) && (
        <Button size="small" icon={<Ungroup size={13} />} onClick={ungroupSelection}>
          Ungroup
        </Button>
      )}
      <div className="stage-bar-size">
        <SizeSelect compact />
      </div>
      <Button size="small" onClick={() => setPanel('settings')}>
        <span className="color-dot" style={{ background: doc.settings.background }} /> Background
      </Button>
      <Button size="small" icon={<Settings size={13} />} onClick={() => setPanel('settings')}>
        Settings
      </Button>
    </div>
  );
}

function WelcomeBody({ projectId, close }: { projectId: ID; close: () => void }): ReactNode {
  const [over, setOver] = useState(false);
  const then = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <Modal title="Let's make a video" size="wide" onClose={close}>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        data-autofocus
        onClick={then(() => void pickIntoProject('media', projectId))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') then(() => void pickIntoProject('media', projectId))();
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const paths = droppedPaths(e.dataTransfer);
          close();
          void importPathsIntoProject(paths, projectId);
        }}
      >
        <div className="dz-icon">
          <Upload size={18} />
        </div>
        <strong>Upload files</strong>
        <span>Choose files or drag them here</span>
        <span className="faint">{SUPPORTED_SUMMARY}</span>
      </div>
      <div className="welcome-options">
        <button type="button" className="welcome-option" onClick={then(() => openPhoneDialog(projectId))}>
          <Smartphone size={20} />
          <strong>Upload from phone</strong>
          <span>Send files over Wi-Fi</span>
        </button>
        <button type="button" className="welcome-option" onClick={then(() => void openRecorder({ projectId, addToTimeline: true }))}>
          <Clapperboard size={20} />
          <strong>Start by recording</strong>
          <span>Screen, camera or both</span>
        </button>
        <button type="button" className="welcome-option" onClick={then(() => openSpeechDialog(projectId))}>
          <Speech size={20} />
          <strong>Start with a script</strong>
          <span>Turn text into a voice-over</span>
        </button>
      </div>
    </Modal>
  );
}

function useShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || document.querySelector('.modal-backdrop')) return;
      const key = e.key.toLowerCase();
      if (isMod(e)) {
        const run = (fn: () => unknown): void => {
          e.preventDefault();
          fn();
        };
        if (key === 'z') run(e.shiftKey ? redo : undo);
        else if (key === 'y') run(redo);
        else if (key === 'c') run(copySelection);
        else if (key === 'v') run(() => paste());
        else if (key === 'd') run(duplicateSelection);
        else if (key === 'a') run(selectAll);
        else if (key === 'g') run(e.shiftKey ? ungroupSelection : groupSelection);
        else if (key === 'x') {
          run(() => {
            if (copySelection()) deleteSelection();
          });
        }
        return;
      }
      switch (key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 's':
          if (!e.repeat) void splitAtPlayhead();
          break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          deleteSelection();
          break;
        case 'arrowleft':
          e.preventDefault();
          stepFrames(e.shiftKey ? -(useEditor.getState().doc?.settings.fps ?? 30) : -1);
          break;
        case 'arrowright':
          e.preventDefault();
          stepFrames(e.shiftKey ? (useEditor.getState().doc?.settings.fps ?? 30) : 1);
          break;
        case 'home':
          pause();
          seek(0);
          break;
        case 'end': {
          const doc = useEditor.getState().doc;
          pause();
          if (doc) seek(projectDuration(doc));
          break;
        }
        case '=':
        case '+':
          setZoom(useEditor.getState().pxPerSec * 1.3);
          break;
        case '-':
          setZoom(useEditor.getState().pxPerSec / 1.3);
          break;
        case 'escape':
          clearSelection();
          break;
      }
    };
    const offMenu = api.on('menu:action', (action) => {
      // On macOS these arrive through the application menu.
      if (isTyping()) document.execCommand(action);
      else if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else selectAll();
    });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offMenu();
    };
  }, [enabled]);
}

/** Saves the project and refreshes its picture on the dashboard. */
export async function saveAndThumbnail(): Promise<void> {
  const doc = useEditor.getState().doc;
  if (!doc) return;
  pause();
  await flushSave();
  await updateProjectThumb(doc).catch(() => undefined);
}

export function EditorPage({ projectId, welcome, showAi }: { projectId: ID; welcome?: boolean; showAi?: boolean }): ReactNode {
  const doc = useEditor((s) => s.doc);
  const panel = useEditor((s) => s.panel);
  const inspecting = useEditor((s) => s.inspecting);
  const timelineHeight = usePrefs((s) => s.timelineHeight);
  const kits = useLibrary((s) => s.lib?.brandKits);
  const render = useLibrary((s) => s.render);
  const [failed, setFailed] = useState('');
  const welcomed = useRef(false);
  const ready = doc?.id === projectId;

  useEffect(() => {
    let live = true;
    openProject(projectId).then(
      () => {
        if (!live) return;
        const opened = useEditor.getState().doc;
        // With generations under way, their progress is what there is to see.
        const generating = useLibrary.getState().lib?.aiJobs?.some((j) => isActive(j) && j.request.target.projectId === projectId);
        if (showAi || generating) setPanel('ai');
        if (welcome && !welcomed.current && opened && !opened.items.length) {
          welcomed.current = true;
          void showModal<void>((close) => <WelcomeBody projectId={projectId} close={() => close()} />);
        }
      },
      (err) => live && setFailed(errorMessage(err)),
    );
    const off = onLeave(saveAndThumbnail);
    return () => {
      live = false;
      off();
      pause();
      forgetDrafts(projectId);
      void closeProject(projectId);
    };
  }, [projectId, welcome, showAi]);

  useEffect(() => {
    if (kits) void loadBrandFonts(kits);
  }, [kits]);

  useShortcuts(ready);

  const exporting = isRendering(render, projectId);

  const done = async (): Promise<void> => {
    try {
      await saveAndThumbnail();
      const current = useEditor.getState().doc;
      if (!current) return;
      await startRender(current, { kind: 'export' });
      await navigate({ page: 'video', projectId });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  if (failed) {
    return (
      <div className="page-center">
        <div className="empty">
          <div className="empty-icon">
            <CircleAlert size={22} />
          </div>
          <h2>This project could not be opened</h2>
          <p>{failed}</p>
          <Button onClick={() => void navigate({ page: 'library', view: { kind: 'all' } })}>Go to your projects</Button>
        </div>
      </div>
    );
  }
  if (!ready || !doc) {
    return (
      <div className="page-center">
        <Spinner large />
      </div>
    );
  }

  return (
    <div className="editor">
      <TopBar projectId={projectId} onDone={() => void done()} exporting={exporting} />
      <div className="editor-main">
        <nav className="rail" aria-label="Editor tools">
          {RAIL.map((r) => (
            <button key={r.id} type="button" className="rail-item" aria-pressed={!inspecting && panel === r.id} onClick={() => setPanel(r.id)}>
              {r.icon}
              <span>{r.label}</span>
            </button>
          ))}
        </nav>
        <aside className="panel" aria-label="Tool panel">
          {inspecting ? (
            <Inspector projectId={projectId} />
          ) : panel === 'ai' ? (
            <AiPanel projectId={projectId} />
          ) : panel === 'text' ? (
            <TextPanel />
          ) : panel === 'subtitles' ? (
            <SubtitlesPanel projectId={projectId} projectName={doc.name} />
          ) : panel === 'brand' ? (
            <BrandPanel />
          ) : panel === 'settings' ? (
            <SettingsPanel projectId={projectId} />
          ) : (
            <MediaPanel key={panel} kind={panel} projectId={projectId} />
          )}
        </aside>
        <main className="editor-center">
          <Stage projectId={projectId} />
          <StageBar />
        </main>
      </div>
      <TimelineResizer />
      <div className="editor-timeline" style={{ height: timelineHeight }}>
        <Timeline projectId={projectId} />
      </div>
    </div>
  );
}
