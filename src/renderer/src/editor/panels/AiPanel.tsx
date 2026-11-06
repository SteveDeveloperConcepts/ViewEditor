// The AI tools panel: generate clips and pictures straight into the project.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { AiTask } from '@shared/ai';
import type { ID } from '@shared/types';
import { IconButton } from '@/components/ui';
import { AiForm } from '@/ai/AiForm';
import { openConnections } from '@/ai/ConnectionsDialog';
import { draftTask, saveDraftTask } from '@/ai/drafts';
import { JobList } from '@/ai/JobList';
import { useEditor } from '@/store/editor';

const TASKS: { task: AiTask; label: string; placeholder: string; hint?: string }[] = [
  { task: 'text-to-video', label: 'Text to video', placeholder: 'A slow aerial shot over a coastline at sunrise' },
  { task: 'image-to-video', label: 'Image to video', placeholder: 'The camera drifts forward as the scene comes to life' },
  { task: 'text-to-image', label: 'Text to image', placeholder: 'A clean product photo on a warm background' },
  { task: 'talking-photo', label: 'Talking photo', placeholder: '', hint: 'Pick a portrait and a voice-over. Text to speech under Audio can make one.' },
  { task: 'edit-video', label: 'Edit a video', placeholder: 'Change the jacket to red leather', hint: 'To edit a clip on the timeline, select it and choose Edit with AI.' },
];

export function AiPanel({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const [task, setTask] = useState<AiTask>(() => draftTask(projectId) ?? 'text-to-video');
  const current = TASKS.find((t) => t.task === task)!;
  const choose = (next: AiTask): void => {
    setTask(next);
    saveDraftTask(projectId, next);
  };
  return (
    <div className="panel-body">
      <div className="row">
        <h2 className="panel-title grow">AI tools</h2>
        <IconButton label="Manage AI connections" onClick={openConnections}>
          <Settings2 size={15} />
        </IconButton>
      </div>
      <select className="select" aria-label="What to generate" value={task} onChange={(e) => choose(e.target.value as AiTask)}>
        {TASKS.map((t) => (
          <option key={t.task} value={t.task}>
            {t.label}
          </option>
        ))}
      </select>
      {current.hint && <p className="faint panel-note">{current.hint}</p>}
      <AiForm
        key={task}
        task={task}
        draftKey={`${projectId}:${task}`}
        projectId={projectId}
        placement={{ kind: 'timeline' }}
        width={doc.settings.width}
        height={doc.settings.height}
        promptPlaceholder={current.placeholder}
      />
      <JobList projectId={projectId} />
    </div>
  );
}
