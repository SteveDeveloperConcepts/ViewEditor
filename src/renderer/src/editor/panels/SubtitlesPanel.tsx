// Subtitles are text clips on their own row that share one look. They can be made from the speech in the
// project through a connected service, typed in, added from an SRT or VTT file, or saved as one again.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Captions, FileDown, FileUp, Plus, Sparkles, Trash2 } from 'lucide-react';
import { SUBTITLE_STYLES } from '@shared/constants';
import { fullWindow, resolveOutputSpec } from '@shared/render';
import { chunkCue, parseSubtitles, toSrt } from '@shared/subtitles';
import { formatTimecode, snapToFrame } from '@shared/time';
import { isTimed, itemEnd, removeItems, trimEndTo, trimStartTo, updateItems } from '@shared/timeline';
import type { ID, TextItem } from '@shared/types';
import { openConnections } from '@/ai/ConnectionsDialog';
import { confirmDialog } from '@/components/Modal';
import { Button, IconButton, Spinner, TimeInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAi } from '@/store/ai';
import { addSubtitles, apply, applySubtitlePreset, flushSave, select, updateText, useEditor } from '@/store/editor';
import { getAssets } from '@/store/library';
import { toast } from '@/store/ui';
import { seek } from '../player';

function cuesOf(items: { type: string }[]): TextItem[] {
  return (items as TextItem[]).filter((it) => it.type === 'text' && it.subtitle).sort((a, b) => a.start - b.start);
}

function CueRow({ cue, active }: { cue: TextItem; active: boolean }): ReactNode {
  return (
    <div className={`cue${active ? ' active' : ''}`}>
      <div className="cue-times">
        <TimeInput label="Cue start" value={cue.start} onCommit={(t) => apply((doc) => updateItems(doc, [cue.id], (it) => trimStartTo(doc, it, t)))} />
        <TimeInput label="Cue end" value={itemEnd(cue)} onCommit={(t) => apply((doc) => updateItems(doc, [cue.id], (it) => trimEndTo(doc, it, t, undefined)))} />
        <IconButton small label="Delete subtitle" onClick={() => apply((d) => removeItems(d, [cue.id]))}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <textarea
        className="textarea cue-text"
        rows={2}
        aria-label="Subtitle text"
        value={cue.text}
        onFocus={() => {
          seek(cue.start);
          select([cue.id], { inspect: false });
        }}
        onChange={(e) => updateText(cue.id, { text: e.target.value }, 'cue-text')}
      />
    </div>
  );
}

export function SubtitlesPanel({ projectName }: { projectName: string; projectId: ID }): ReactNode {
  const items = useEditor((s) => s.doc?.items) ?? [];
  const t = useEditor((s) => Math.floor(s.playhead * 4) / 4);
  const cues = cuesOf(items);
  const [listening, setListening] = useState(false);

  const automatic = async (): Promise<void> => {
    const assets = getAssets();
    const heard = items.some((it) => isTimed(it) && !it.muted && assets[it.assetId]?.hasAudio);
    if (!heard) {
      toast('There is no sound in this project to make subtitles from.');
      return;
    }
    if (!useAi.getState().providers.some((p) => p.id === 'fal' && p.connected)) {
      toast('Automatic subtitles use fal.ai. Connect it here, then try again.');
      void openConnections();
      return;
    }
    const go = await confirmDialog({
      title: 'Make subtitles from the speech?',
      message: 'The sound of this project is sent to fal.ai, which writes down what is said. It is billed to your fal.ai account.',
      confirmLabel: 'Make subtitles',
    });
    if (!go) return;
    setListening(true);
    try {
      await flushSave();
      const doc = useEditor.getState().doc;
      if (!doc) return;
      const speech = await api.ai.transcribe({ doc, window: fullWindow(doc), spec: resolveOutputSpec(doc, assets) });
      const added = addSubtitles(speech.flatMap((s) => chunkCue(s.text, s.start, s.end)));
      if (added.length) toast(`Added ${added.length} subtitle${added.length === 1 ? '' : 's'}. Check the words, since they are only a good guess.`, { kind: 'success' });
      else toast('No speech was found in this project.');
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    } finally {
      setListening(false);
    }
  };

  const addCue = (): void => {
    const s = useEditor.getState();
    const fps = s.doc?.settings.fps ?? 30;
    const at = snapToFrame(s.playhead, fps);
    const nextCue = cues.find((c) => c.start >= at);
    const end = Math.min(at + 2.5, nextCue?.start ?? Infinity);
    if (cues.some((c) => c.start <= at && itemEnd(c) > at) || end - at < 0.2) {
      toast('There is already a subtitle at the playhead. Move the playhead to an empty spot first.');
      return;
    }
    addSubtitles([{ start: at, end, text: 'New subtitle' }]);
  };

  const importFile = async (): Promise<void> => {
    try {
      const file = await api.app.pickTextFile();
      if (!file) return;
      const parsed = parseSubtitles(file.text);
      if (!parsed.length) {
        toast(`No subtitles were found in ${file.name}.`, { kind: 'error' });
        return;
      }
      const added = addSubtitles(parsed);
      toast(`Added ${added.length} subtitle${added.length === 1 ? '' : 's'} from ${file.name}.`, { kind: 'success' });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  const exportFile = (): void => {
    const blob = new Blob([toSrt(cues.map((c) => ({ start: c.start, end: itemEnd(c), text: c.text })))], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${projectName}.srt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="panel-body">
      <h2 className="panel-title">Subtitles</h2>
      <Button variant="primary" block icon={listening ? <Spinner /> : <Sparkles size={14} />} disabled={listening} onClick={() => void automatic()}>
        {listening ? 'Listening…' : 'Make subtitles automatically'}
      </Button>
      <div className="panel-actions">
        <Button icon={<Plus size={14} />} onClick={addCue}>
          Add subtitle
        </Button>
        <Button icon={<FileUp size={14} />} onClick={() => void importFile()}>
          Add SRT or VTT
        </Button>
      </div>
      {cues.length > 0 ? (
        <>
          <section>
            <h3>Style</h3>
            <div className="subtitle-styles">
              {SUBTITLE_STYLES.map((p) => (
                <button key={p.id} type="button" className="subtitle-style" onClick={() => applySubtitlePreset(p.id)}>
                  <span
                    style={{
                      fontFamily: p.style.fontFamily,
                      fontWeight: p.style.bold ? 700 : 400,
                      fontStyle: p.style.italic ? 'italic' : undefined,
                      textTransform: p.style.uppercase ? 'uppercase' : undefined,
                      color: p.style.color,
                      background: p.style.bgColor ?? undefined,
                      padding: p.style.bgColor ? '1px 6px' : undefined,
                      borderRadius: 4,
                      WebkitTextStroke: p.style.strokeColor ? `2px ${p.style.strokeColor}` : undefined,
                      paintOrder: 'stroke fill',
                    }}
                  >
                    {p.label}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="cue-list">
            <div className="row">
              <h3 className="grow">
                {cues.length} subtitle{cues.length === 1 ? '' : 's'}
              </h3>
              <Button variant="ghost" size="small" icon={<FileDown size={13} />} onClick={exportFile}>
                Save .srt
              </Button>
            </div>
            {cues.map((c) => (
              <CueRow key={c.id} cue={c} active={t >= c.start - 0.25 && t < itemEnd(c)} />
            ))}
          </section>
        </>
      ) : (
        <div className="empty small">
          <div className="empty-icon">
            <Captions size={20} />
          </div>
          <p>Make them from the speech in your video, add them by hand, or use an SRT or VTT file. Text to speech adds its own.</p>
        </div>
      )}
      {cues.length > 0 && <p className="faint panel-note">Total length {formatTimecode(itemEnd(cues[cues.length - 1]))}</p>}
    </div>
  );
}
