// What has been entered in the AI panel. It lives here rather than in the form, because the form goes
// away whenever another panel is shown and has to come back as it was. Closing the project forgets it.

import { create } from 'zustand';
import type { AiChoices, AiMediaRef, AiTask } from '@shared/ai';
import type { ID } from '@shared/types';

/** Where a new clip's sound comes from: nowhere, the model, or something in Media. */
export type SoundMode = 'none' | 'ai' | 'mine';

export interface AiFormDraft {
  choices: AiChoices;
  /** The shape was picked by hand, so it should no longer follow the project's frame. */
  shapePicked: boolean;
  image: AiMediaRef | null;
  video: AiMediaRef | null;
  audio: AiMediaRef | null;
  soundMode: SoundMode;
  /** The sound chosen from Media. */
  mine: AiMediaRef | null;
  /** The length asked for, which the chosen model may not be able to make exactly. */
  wanted: number | null;
}

const forms = new Map<string, AiFormDraft>();
const tasks = new Map<ID, AiTask>();

export function formDraft(key: string | undefined): AiFormDraft | undefined {
  return key ? forms.get(key) : undefined;
}

export function saveFormDraft(key: string, draft: AiFormDraft): void {
  forms.set(key, draft);
}

export function draftTask(projectId: ID): AiTask | undefined {
  return tasks.get(projectId);
}

export function saveDraftTask(projectId: ID, task: AiTask): void {
  tasks.set(projectId, task);
}

/** Changes when a form has been filled in from outside, so one already on screen starts again from its draft. */
export const useDraftRevision = create<{ n: number }>(() => ({ n: 0 }));

/** Fills in the AI form for a picture to go with this sound, at the length of the sound. */
export function draftForSound(projectId: ID, sound: AiMediaRef, seconds: number): void {
  const task: AiTask = 'text-to-video';
  saveDraftTask(projectId, task);
  saveFormDraft(`${projectId}:${task}`, { choices: {}, shapePicked: false, image: null, video: null, audio: null, soundMode: 'mine', mine: sound, wanted: seconds });
  useDraftRevision.setState((s) => ({ n: s.n + 1 }));
}

export function forgetDrafts(projectId: ID): void {
  tasks.delete(projectId);
  for (const key of forms.keys()) if (key.startsWith(`${projectId}:`)) forms.delete(key);
}
