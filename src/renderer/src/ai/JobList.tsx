// Generations in progress and recently finished.

import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Plus, RefreshCw, X } from 'lucide-react';
import { isActive, type AiJob } from '@shared/ai';
import { formatRelative } from '@shared/time';
import type { ID } from '@shared/types';
import { Button, IconButton, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { assetUrl } from '@/lib/media';
import { startProjectWithAsset } from '@/lib/projects';
import { addAsset, useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/ui';

function stateText(job: AiJob): string {
  switch (job.state) {
    case 'preparing':
      return 'Preparing…';
    case 'uploading':
      return 'Sending…';
    case 'queued':
      return job.queuePosition !== null ? `In the queue (${job.queuePosition + 1})` : 'In the queue…';
    case 'running':
      return job.progress !== null ? `Generating ${Math.round(job.progress * 100)}%` : 'Generating…';
    case 'downloading':
      return 'Saving…';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

async function retry(job: AiJob): Promise<void> {
  try {
    await api.ai.generate(job.request);
    await api.ai.dismiss(job.id);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function JobRow({ job }: { job: AiJob }): ReactNode {
  const asset = useLibrary((s) => (job.assetId ? s.assetsById[job.assetId] : undefined));
  const docOpen = useEditor((s) => !!s.doc);
  const active = isActive(job);
  return (
    <div className={`ai-job ${job.state}`} data-job-state={job.state}>
      <div className="ai-job-picture">
        {asset?.hasThumb ? <img src={assetUrl(asset, 'thumb')} alt="" draggable={false} /> : active ? <Spinner /> : job.state === 'failed' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
      </div>
      <div className="grow">
        <div className="truncate ai-job-name" title={job.prompt || job.name}>
          {job.name}
        </div>
        <div className="faint truncate" title={job.error ?? undefined}>
          {job.state === 'failed' ? job.error : job.state === 'done' ? `${job.modelLabel} · ${formatRelative(job.finishedAt ?? job.createdAt)}` : `${job.modelLabel} · ${stateText(job)}`}
        </div>
      </div>
      {job.state === 'done' && asset && docOpen && job.request.placement.kind === 'timeline' && job.applied && (
        <IconButton small label="Add to the timeline again" onClick={() => void addAsset(asset)}>
          <Plus size={14} />
        </IconButton>
      )}
      {job.state === 'done' && asset && !docOpen && (
        <Button size="small" onClick={() => void startProjectWithAsset(asset, job.name).catch((err) => toast(errorMessage(err), { kind: 'error' }))}>
          Use in a project
        </Button>
      )}
      {job.state === 'failed' && (
        <IconButton small label="Try again" onClick={() => void retry(job)}>
          <RefreshCw size={13} />
        </IconButton>
      )}
      {active ? (
        <Button size="small" variant="ghost" onClick={() => void api.ai.cancel(job.id)}>
          Cancel
        </Button>
      ) : (
        <IconButton small label="Remove from this list" onClick={() => void api.ai.dismiss(job.id)}>
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}

export function JobList({ projectId }: { projectId: ID | null }): ReactNode {
  const jobs = useLibrary((s) => s.lib?.aiJobs);
  const mine = (jobs ?? []).filter((j) => (j.request.target.projectId ?? null) === projectId).sort((a, b) => b.createdAt - a.createdAt);
  if (!mine.length) return null;
  return (
    <section className="ai-jobs">
      <h3>Generations</h3>
      {mine.slice(0, 12).map((j) => (
        <JobRow key={j.id} job={j} />
      ))}
    </section>
  );
}
