// AI actions on one element of the timeline: edit it, extend it, animate it, make it talk.

import type { ReactNode } from 'react';
import { formatClock } from '@shared/time';
import type { AiTask } from '@shared/ai';
import type { ID, Item } from '@shared/types';
import { Modal } from '@/components/Modal';
import { useEditor } from '@/store/editor';
import { getAssets } from '@/store/library';
import { showModal } from '@/store/ui';
import { AiForm, type AiFormProps } from './AiForm';

export type ClipAction = 'edit' | 'extend' | 'animate' | 'talk' | 'lip-sync';

interface ActionInfo {
  title: string;
  task: AiTask;
  submit: string;
  promptLabel: string;
  placeholder: string;
}

const ACTIONS: Record<ClipAction, ActionInfo> = {
  edit: { title: 'Edit with AI', task: 'edit-video', submit: 'Edit this clip', promptLabel: 'What should change?', placeholder: 'Make it night time, with rain on the windows' },
  extend: { title: 'Extend with AI', task: 'image-to-video', submit: 'Extend this clip', promptLabel: 'What happens next?', placeholder: 'The camera keeps moving forward through the door' },
  animate: { title: 'Animate with AI', task: 'image-to-video', submit: 'Animate this image', promptLabel: 'How should it move?', placeholder: 'A slow push in as the leaves drift past' },
  talk: { title: 'Make it talk', task: 'talking-photo', submit: 'Make it talk', promptLabel: 'Notes', placeholder: '' },
  'lip-sync': { title: 'Lip-sync with AI', task: 'lip-sync', submit: 'Lip-sync this clip', promptLabel: 'Notes', placeholder: '' },
};

/** The actions that make sense for an element. */
export function actionsFor(item: Item): ClipAction[] {
  if (item.type === 'video') return ['edit', 'extend', 'lip-sync'];
  if (item.type === 'image') return ['animate', 'talk'];
  return [];
}

export function actionLabel(action: ClipAction): string {
  return ACTIONS[action].title;
}

function formProps(item: Item, action: ClipAction): Partial<AiFormProps> {
  if (item.type !== 'video' && item.type !== 'image') return {};
  if (item.type === 'image') {
    const replace = { placement: { kind: 'replace', itemId: item.id } as const };
    return action === 'talk'
      ? { image: { assetId: item.assetId }, note: 'This picture and the audio you choose are sent to the service. The result replaces the image on the timeline.', ...replace }
      : { image: { assetId: item.assetId }, note: 'This picture is sent to the service. The result replaces the image on the timeline.', ...replace };
  }
  const start = item.trimStart;
  const end = item.trimStart + item.duration * item.speed;
  const length = formatClock(end - start);
  if (action === 'extend') {
    const fps = getAssets()[item.assetId]?.fps || 30;
    return {
      image: { assetId: item.assetId, frameAt: end - 1 / fps },
      placement: { kind: 'after', itemId: item.id },
      note: 'The last frame of this clip is sent to the service. The new shot goes straight after it on the timeline.',
    };
  }
  return {
    video: { assetId: item.assetId, start, end },
    placement: { kind: 'replace', itemId: item.id },
    note: `The ${length} of footage in this clip is sent to the service. The result replaces it on the timeline, and undo brings the original back. Most models accept 10 to 30 seconds, so split longer clips first.`,
  };
}

function ClipBody({ item, action, projectId, close }: { item: Item; action: ClipAction; projectId: ID; close: () => void }): ReactNode {
  const doc = useEditor((s) => s.doc);
  const info = ACTIONS[action];
  return (
    <Modal title={info.title} onClose={close}>
      <AiForm
        task={info.task}
        projectId={projectId}
        placement={{ kind: 'timeline' }}
        width={doc?.settings.width ?? 1920}
        height={doc?.settings.height ?? 1080}
        promptLabel={info.promptLabel}
        promptPlaceholder={info.placeholder}
        submitLabel={info.submit}
        onSubmitted={close}
        {...formProps(item, action)}
      />
    </Modal>
  );
}

export function openClipAi(item: Item, action: ClipAction, projectId: ID): void {
  void showModal<void>((close) => <ClipBody item={item} action={action} projectId={projectId} close={() => close()} />);
}

/** True while this element is waiting on a generation that will replace it. */
export function isBeingReplaced(jobs: { state: string; request: { placement: { kind: string; itemId?: ID } } }[] | undefined, item: Item): boolean {
  return (jobs ?? []).some((j) => j.request.placement.kind === 'replace' && j.request.placement.itemId === item.id && !['done', 'failed', 'cancelled'].includes(j.state));
}
