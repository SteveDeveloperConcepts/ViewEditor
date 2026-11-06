// The AI tools panel: every AI tool in one place. A clip's own AI actions open here with the clip filled in.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { AiPlacement, AiTask } from '@shared/ai';
import type { ID } from '@shared/types';
import { Field, IconButton } from '@/components/ui';
import { AiForm } from '@/ai/AiForm';
import { ClipAiForm, useClipAi } from '@/ai/clipActions';
import { openConnections } from '@/ai/ConnectionsDialog';
import { draftTask, draftWhere, saveDraftTask, saveDraftWhere, useDraftRevision, type Where } from '@/ai/drafts';
import { JobList } from '@/ai/JobList';
import { useEditor } from '@/store/editor';

const TASKS: { task: AiTask; label: string; placeholder: string; hint?: string }[] = [
  { task: 'text-to-video', label: 'Text to video', placeholder: 'A slow aerial shot over a coastline at sunrise' },
  { task: 'image-to-video', label: 'Image to video', placeholder: 'The camera drifts forward as the scene comes to life' },
  { task: 'text-to-image', label: 'Text to image', placeholder: 'A clean product photo on a warm background' },
  { task: 'talking-photo', label: 'Talking photo', placeholder: '', hint: 'Pick a portrait, and audio or a video with sound. Text to speech under Audio can make a voice-over.' },
  { task: 'edit-video', label: 'Edit a video', placeholder: 'Change the jacket to red leather', hint: 'To edit a clip on the timeline, select it and choose Edit with AI.' },
  { task: 'lip-sync', label: 'Lip-sync a video', placeholder: '', hint: 'Pick a video, and the sound it should speak.' },
];

export function AiPanel({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const request = useClipAi((s) => s.request);
  const clip = request && doc.items.find((it) => it.id === request.itemId);
  const [picked, setTask] = useState<AiTask>('text-to-video');
  const revision = useDraftRevision((s) => s.n);
  const task = draftTask(projectId) ?? picked;
  const [where, setWhere] = useState<Where>(() => draftWhere(projectId));
  const current = TASKS.find((t) => t.task === task)!;
  const choose = (next: AiTask): void => {
    setTask(next);
    saveDraftTask(projectId, next);
  };
  const place = (next: Where): void => {
    setWhere(next);
    saveDraftWhere(projectId, next);
  };
  const placement = (): AiPlacement => ({ kind: 'timeline', at: useEditor.getState().playhead, sequence: where === 'end' });
  return (
    <div className="panel-body">
      <div className="row">
        <h2 className="panel-title grow">AI tools</h2>
        <IconButton label="Manage AI connections" onClick={openConnections}>
          <Settings2 size={15} />
        </IconButton>
      </div>
      {clip && request ? (
        <ClipAiForm item={clip} action={request.action} projectId={projectId} />
      ) : (
        <>
          <select className="select" aria-label="What to generate" value={task} onChange={(e) => choose(e.target.value as AiTask)}>
            {TASKS.map((t) => (
              <option key={t.task} value={t.task}>
                {t.label}
              </option>
            ))}
          </select>
          {current.hint && <p className="faint panel-note">{current.hint}</p>}
          <AiForm
            key={`${task}:${revision}`}
            task={task}
            draftKey={`${projectId}:${task}`}
            projectId={projectId}
            placement={placement}
            newClip={task === 'text-to-video' || task === 'image-to-video'}
            width={doc.settings.width}
            height={doc.settings.height}
            promptPlaceholder={current.placeholder}
            extra={
              doc.items.length > 0 && (
                <Field label="Place it">
                  <select className="select" aria-label="Where to place the result" value={where} onChange={(e) => place(e.target.value as Where)}>
                    <option value="playhead">At the playhead, over the video</option>
                    <option value="end">After the last clip</option>
                  </select>
                </Field>
              )
            }
          />
        </>
      )}
      <JobList projectId={projectId} />
    </div>
  );
}
