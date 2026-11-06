// "How do I…": search for something to do and do it, or read how a job is done from start to finish.

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { CircleHelp, Search, Sparkles } from 'lucide-react';
import { openConnections } from '@/ai/ConnectionsDialog';
import { extractAudioFrom } from '@/editor/actions';
import { openExportDialog } from '@/editor/ExportDialog';
import { openProjectSettings } from '@/editor/ProjectSettings';
import { isMod, MOD_LABEL } from '@/lib/api';
import { startBlankProject } from '@/lib/projects';
import { openStartDialog } from '@/lib/startDialog';
import { openSettings, openShortcuts } from '@/pages/SettingsDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { addText, redo, selectedItems, setPanel, splitAtPlayhead, undo, useEditor } from '@/store/editor';
import { navigate, showModal, toast, useUi } from '@/store/ui';
import { Modal } from './Modal';
import { Button } from './ui';

interface Action {
  label: string;
  /** Other words people use for it. */
  words: string;
  run: () => void;
}

/** What can be done from here. The editor adds what only makes sense with a project open. */
function actions(): Action[] {
  const projectId = useEditor.getState().doc?.id;
  const everywhere: Action[] = [
    { label: 'Edit my footage', words: 'open import add video start new project', run: () => openStartDialog() },
    { label: 'Generate with AI', words: 'make create clip text to video image', run: () => void startBlankProject({}, true) },
    { label: 'Video from a script', words: 'narrated voice text speech topic', run: () => void navigate({ page: 'script' }) },
    { label: 'Record', words: 'screen camera webcam capture', run: () => void openRecorder(projectId ? { projectId, addToTimeline: true } : {}) },
    { label: 'Go to Projects', words: 'library folders trash all videos', run: () => void navigate({ page: 'library', view: { kind: 'all' } }) },
    { label: 'Go to Media', words: 'files assets library clips audio pictures', run: () => void navigate({ page: 'assets' }) },
    { label: 'Go to Templates', words: 'layouts reuse', run: () => void navigate({ page: 'templates' }) },
    { label: 'Go to Brand', words: 'logo colours fonts kit', run: () => void navigate({ page: 'brand' }) },
    { label: 'AI connections', words: 'keys api fal runway replicate claude accounts', run: () => void openConnections() },
    { label: 'App settings', words: 'theme dark light appearance', run: openSettings },
    { label: 'Keyboard shortcuts', words: 'keys help', run: openShortcuts },
  ];
  if (!projectId) return everywhere;
  const clip = selectedItems().find((it) => it.type === 'video');
  return [
    { label: 'Export', words: 'save render finish download mp4 mp3 gif section', run: () => openExportDialog(projectId) },
    { label: 'Extract audio', words: 'sound separate detach take out rip', run: () => (clip ? void extractAudioFrom(clip) : setAudioHint()) },
    { label: 'Split at the playhead', words: 'cut slice', run: () => void splitAtPlayhead() },
    { label: 'Add text', words: 'title heading words caption', run: () => void addText('heading') },
    { label: 'Add subtitles', words: 'captions srt vtt transcribe', run: () => setPanel('subtitles') },
    { label: 'AI tools', words: 'generate lip sync talking photo', run: () => setPanel('ai') },
    { label: 'Project settings', words: 'shape size background length frame rate fps', run: () => openProjectSettings(projectId) },
    { label: 'Undo', words: 'back revert', run: undo },
    { label: 'Redo', words: 'again', run: redo },
    ...everywhere,
  ];
}

function setAudioHint(): void {
  setPanel('audio');
  toast('Select a video clip first, or choose one under Extract audio from a video.');
}

const TOPICS: { title: string; words: string; steps: string[] }[] = [
  {
    title: 'Make an AI clip with the sound of a recording',
    words: 'audio extract generate voice',
    steps: [
      'Choose Generate with AI in the left menu.',
      'Set Length, and write what the picture should show.',
      'Under Sound, choose My media, and pick your recording. If it is not there yet, use the button beside the list to add it.',
      'Drag the window along the waveform to choose which part of the sound to use.',
      'Press Generate. The clip and the sound land on the timeline together, lined up.',
      'Press Export, and Export again in the dialog. On the page that follows, choose MP4 under Save as.',
    ],
  },
  {
    title: 'Take the sound out of a video',
    words: 'extract audio separate detach mp3',
    steps: ['Right-click the clip on the timeline and choose Extract audio.', 'The sound becomes its own clip on a row below, and the video is muted.', 'In Media, right-click any video to keep just its sound there.'],
  },
  {
    title: 'Save part of a video',
    words: 'export section clip range trim',
    steps: ['Select the clips you want, or press Export and choose A stretch of time.', 'Choose Video, Sound only or GIF, then press Export and pick where to save it.'],
  },
  {
    title: 'Put one clip over another',
    words: 'layer stack overlay rows picture in picture',
    steps: ['Move the playhead to where it should start.', 'Click the clip in Media. It lands on a new row at the playhead.', 'Where rows overlap, the higher row covers the lower one. Use the eye beside a row to hide it for a moment.'],
  },
  {
    title: 'Add subtitles',
    words: 'captions transcribe srt vtt automatic',
    steps: ['Open Subtitles in the editor.', 'Make them automatically from the speech if fal.ai is connected, add them by hand, or use an SRT or VTT file.', 'Choose a style, then click a subtitle to change its words or timing.'],
  },
  {
    title: 'Replace the sound of a video with a voice-over',
    words: 'narration text to speech mute microphone',
    steps: ['Open Audio in the editor, and choose Voice-over or Text to speech.', 'When it lands, the app asks whether to mute the sound underneath.'],
  },
  {
    title: 'Use something in another project',
    words: 'reuse media library recording',
    steps: ['Everything you add, record or generate is kept in Media.', 'In a project, find it under Media or Audio in the editor. From Media in the left menu, click it and choose Use in, or Start a project.'],
  },
  {
    title: 'Change the shape of a video',
    words: 'size portrait square landscape aspect ratio tiktok',
    steps: ['Use the Shape list under the picture in the editor.', 'To keep the original too, choose Copy in a new shape from the project’s menu under Projects.'],
  },
];

/** Words that say nothing about what someone wants to do. */
const FILLER = new Set(['a', 'an', 'and', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'want', 'with']);

function wordsIn(query: string): string[] {
  return [...new Set(query.split(/[^\p{L}\p{N}]+/u))].filter((w) => w && !FILLER.has(w));
}

/** How many of the words a text has. Long words also count by their stem, so "extracted" finds "extract". */
function score(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w) || (w.length > 5 && lower.includes(w.slice(0, -2)))).length;
}

/** The best matches for a sentence in someone's own words, best first. Weak matches go when there are strong ones. */
function ranked<T>(list: T[], textOf: (item: T) => string, words: string[]): T[] {
  const scored = list.map((item) => ({ item, points: score(textOf(item), words) })).filter((s) => s.points > 0);
  const best = Math.max(0, ...scored.map((s) => s.points));
  return scored
    .filter((s) => s.points >= best * 0.6)
    .sort((a, b) => b.points - a.points)
    .map((s) => s.item);
}

function HelpBody({ close }: { close: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const list = useMemo(() => actions(), []);
  const words = wordsIn(q);
  const found = ranked(list, (a) => `${a.label} ${a.words}`, words).slice(0, 6);
  const topics = q ? ranked(TOPICS, (t) => `${t.title} ${t.words} ${t.steps.join(' ')}`, words) : TOPICS;
  const run = (a: Action): void => {
    close();
    a.run();
  };
  return (
    <Modal title="How do I…" size="wide" onClose={close}>
      <div className="search-box help-search">
        <Search size={14} />
        <input
          className="input"
          data-autofocus
          placeholder="Type what you want to do, such as extract audio"
          aria-label="Search for something to do"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found[0]) {
              e.preventDefault();
              run(found[0]);
            }
          }}
        />
      </div>
      {found.length > 0 && (
        <section className="help-actions">
          {found.map((a) => (
            <button key={a.label} type="button" className="help-action" onClick={() => run(a)}>
              <Sparkles size={14} />
              {a.label}
            </button>
          ))}
        </section>
      )}
      <section className="help-topics">
        {topics.map((t) => (
          <details key={t.title} open={topics.length === 1}>
            <summary>{t.title}</summary>
            <ol>
              {t.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ))}
        {q && !found.length && !topics.length && <p className="faint">Nothing matches that. Try a shorter word.</p>}
      </section>
    </Modal>
  );
}

export function openHelp(): void {
  if (useUi.getState().modals.length) return;
  void showModal<void>((close) => <HelpBody close={() => close()} />);
}

/** The way into Help, with its name on it, on the dashboard and in the editor. */
export function HelpButton(): ReactNode {
  return (
    <Button variant="ghost" size="small" icon={<CircleHelp size={15} />} title={`Search for what you want to do (${MOD_LABEL}+K)`} onClick={openHelp}>
      How do I…
    </Button>
  );
}

/** Ctrl or Cmd + K opens it from anywhere. */
export function useHelpShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isMod(e) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      openHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
