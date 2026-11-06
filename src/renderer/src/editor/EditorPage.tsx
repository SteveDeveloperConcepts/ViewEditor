import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  Check,
  CircleAlert,
  Clapperboard,
  Group,
  Images,
  Music,
  Palette,
  Redo2,
  Settings,
  Share,
  Sparkles,
  Type,
  Undo2,
  Ungroup,
} from 'lucide-react';
import { isActive } from '@shared/ai';
import { projectDuration } from '@shared/timeline';
import type { Asset, ID } from '@shared/types';
import { closeClipAi } from '@/ai/clipActions';
import { forgetDrafts } from '@/ai/drafts';
import { HelpButton } from '@/components/HelpDialog';
import { Button, IconButton, Spinner } from '@/components/ui';
import { api, errorMessage, isMod, isTyping, MOD_LABEL } from '@/lib/api';
import { loadBrandFonts } from '@/lib/fonts';
import { discardIfUnused } from '@/lib/projects';
import { openRecorder } from '@/recorder/openRecorder';
import {
  clearSelection,
  closeProject,
  copySelection,
  deleteSelection,
  duplicateSelection,
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
import { navigate, onLeave } from '@/store/ui';
import { openExportDialog } from './ExportDialog';
import { addToTimeline } from './importing';
import { AiPanel } from './panels/AiPanel';
import { BrandPanel } from './panels/BrandPanel';
import { Inspector } from './panels/Inspector';
import { MediaPanel } from './panels/MediaPanel';
import { SubtitlesPanel } from './panels/SubtitlesPanel';
import { TextPanel } from './panels/TextPanel';
import { pause, seek, stepFrames, togglePlay } from './player';
import { openProjectSettings, SizeSelect } from './ProjectSettings';
import { saveAndThumbnail } from './save';
import { Stage } from './Stage';
import { Timeline, TimelineResizer } from './Timeline';

const RAIL: { id: PanelId; label: string; icon: ReactNode }[] = [
  { id: 'ai', label: 'AI tools', icon: <Sparkles size={18} /> },
  { id: 'media', label: 'Media', icon: <Images size={18} /> },
  { id: 'audio', label: 'Audio', icon: <Music size={18} /> },
  { id: 'text', label: 'Text', icon: <Type size={18} /> },
  { id: 'subtitles', label: 'Subtitles', icon: <Captions size={18} /> },
  { id: 'brand', label: 'Brand', icon: <Palette size={18} /> },
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

function TopBar({ projectId, onExport, exporting }: { projectId: ID; onExport: () => void; exporting: boolean }): ReactNode {
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
      <HelpButton />
      <IconButton label="Project settings" onClick={() => openProjectSettings(projectId)}>
        <Settings size={16} />
      </IconButton>
      <Button variant="ghost" icon={<Clapperboard size={15} />} onClick={() => void openRecorder({ projectId, addToTimeline: true })}>
        Record
      </Button>
      <Button variant="primary" icon={exporting ? <Spinner /> : <Share size={15} />} disabled={empty || exporting} title={empty ? 'Add something to the timeline first' : 'Export this project'} onClick={onExport}>
        Export
      </Button>
    </header>
  );
}

function StageBar({ projectId }: { projectId: ID }): ReactNode {
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
      <Button size="small" onClick={() => openProjectSettings(projectId)}>
        <span className="color-dot" style={{ background: doc.settings.background }} /> Background
      </Button>
    </div>
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

export function EditorPage({ projectId, showAi, add }: { projectId: ID; showAi?: boolean; add?: Asset[] }): ReactNode {
  const doc = useEditor((s) => s.doc);
  const panel = useEditor((s) => s.panel);
  const inspecting = useEditor((s) => s.inspecting);
  const timelineHeight = usePrefs((s) => s.timelineHeight);
  const kits = useLibrary((s) => s.lib?.brandKits);
  const render = useLibrary((s) => s.render);
  const [failed, setFailed] = useState('');
  const ready = doc?.id === projectId;

  useEffect(() => {
    let live = true;
    openProject(projectId).then(
      () => {
        if (!live) return;
        // With generations under way, their progress is what there is to see.
        const generating = useLibrary.getState().lib?.aiJobs?.some((j) => isActive(j) && j.request.target.projectId === projectId);
        if (showAi || generating) setPanel('ai');
        if (add?.length) void addToTimeline(add);
      },
      (err) => live && setFailed(errorMessage(err)),
    );
    const off = onLeave(saveAndThumbnail);
    return () => {
      live = false;
      off();
      pause();
      forgetDrafts(projectId);
      closeClipAi();
      const closing = useEditor.getState().doc;
      void closeProject(projectId).then(() => discardIfUnused(closing?.id === projectId ? closing : null));
    };
  }, [projectId, showAi, add]);

  useEffect(() => {
    if (kits) void loadBrandFonts(kits);
  }, [kits]);

  useShortcuts(ready);

  const exporting = isRendering(render, projectId);

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
      <TopBar projectId={projectId} onExport={() => openExportDialog(projectId)} exporting={exporting} />
      <div className={`editor-main${inspecting ? ' inspecting' : ''}`}>
        <nav className="rail" aria-label="Editor tools">
          {RAIL.map((r) => (
            <button key={r.id} type="button" className="rail-item" aria-pressed={panel === r.id} onClick={() => setPanel(r.id)}>
              {r.icon}
              <span>{r.label}</span>
            </button>
          ))}
        </nav>
        <aside className="panel" aria-label="Tool panel">
          {panel === 'ai' ? (
            <AiPanel projectId={projectId} />
          ) : panel === 'text' ? (
            <TextPanel />
          ) : panel === 'subtitles' ? (
            <SubtitlesPanel projectId={projectId} projectName={doc.name} />
          ) : panel === 'brand' ? (
            <BrandPanel />
          ) : (
            <MediaPanel key={panel} kind={panel} projectId={projectId} />
          )}
        </aside>
        <main className="editor-center">
          <Stage projectId={projectId} />
          <StageBar projectId={projectId} />
        </main>
        {inspecting && (
          <aside className="inspector" aria-label="Clip settings">
            <Inspector />
          </aside>
        )}
      </div>
      <TimelineResizer />
      <div className="editor-timeline" style={{ height: timelineHeight }}>
        <Timeline projectId={projectId} />
      </div>
    </div>
  );
}
