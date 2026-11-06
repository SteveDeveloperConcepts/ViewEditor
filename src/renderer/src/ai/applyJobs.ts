// Puts finished generations where they were meant to go. A job can finish while its project is
// closed, so this also runs whenever a project opens, and a result is placed exactly once.

import type { AiJob } from '@shared/ai';
import { api } from '@/lib/api';
import { placeGenerated, useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { navigate, toast } from '@/store/ui';

/**
 * Jobs placed during this run. The saved `applied` flag comes back a moment after it is set, and a
 * library update arriving in between must not place the same clip a second time.
 */
const placed = new Set<string>();
const announced = new Set<string>();

function place(job: AiJob): void {
  const docId = useEditor.getState().doc?.id;
  const asset = job.assetId ? useLibrary.getState().assetsById[job.assetId] : undefined;
  if (job.state !== 'done' || job.applied || !asset || !docId || job.request.target.projectId !== docId || placed.has(job.id)) return;
  // Images only know their true shape a moment after import.
  if (asset.kind === 'image' && !asset.hasThumb) return;
  placed.add(job.id);
  placeGenerated(asset, job.request.placement);
  void api.ai.markApplied(job.id);
}

function announce(job: AiJob): void {
  if (announced.has(job.id)) return;
  if (job.state === 'failed') {
    announced.add(job.id);
    toast(`${job.name}: ${job.error ?? 'generation failed.'}`, { kind: 'error' });
  } else if (job.state === 'done') {
    announced.add(job.id);
    const projectId = job.request.target.projectId;
    const open = useEditor.getState().doc?.id === projectId;
    toast(`${job.name} is ready.`, {
      kind: 'success',
      action: open
        ? undefined
        : { label: 'View', run: () => void navigate(projectId ? { page: 'editor', projectId } : { page: 'assets' }) },
    });
  }
}

function sweep(): void {
  for (const job of useLibrary.getState().lib?.aiJobs ?? []) {
    place(job);
    announce(job);
  }
}

/** Watches the job list and the open project. */
export function startApplyingJobs(): () => void {
  // What had already finished before this run of the app is old news.
  let seeded = false;
  const seed = (): void => {
    const jobs = useLibrary.getState().lib?.aiJobs;
    if (seeded || !jobs) return;
    seeded = true;
    for (const j of jobs) if (j.state === 'done' || j.state === 'failed') announced.add(j.id);
  };
  seed();
  const offLibrary = useLibrary.subscribe(() => {
    seed();
    sweep();
  });
  const offEditor = useEditor.subscribe((s, prev) => {
    if (s.doc?.id !== prev.doc?.id) sweep();
  });
  return () => {
    offLibrary();
    offEditor();
  };
}
