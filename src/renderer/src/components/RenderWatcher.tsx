// Keeps the user informed about an export when the video page is not on screen.

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { renderActive, useLibrary } from '@/store/library';
import { navigate, toast, useUi } from '@/store/ui';
import { Button, ProgressBar } from './ui';

export function RenderWatcher(): ReactNode {
  const render = useLibrary((s) => s.render);
  const importing = useLibrary((s) => s.importing);
  const route = useUi((s) => s.route);
  const reported = useRef('');
  const onVideoPage = route.page === 'video' && render?.projectId === route.projectId && render.kind === 'export';

  useEffect(() => {
    if (!render || renderActive(render)) return;
    const key = `${render.jobId}:${render.state}`;
    if (reported.current === key) return;
    reported.current = key;
    if (render.state === 'error' && !onVideoPage) {
      toast(`The export did not finish: ${(render.message ?? '').split('\n')[0]}`, { kind: 'error' });
    } else if (render.state === 'done' && render.kind === 'section' && render.outputPath) {
      const path = render.outputPath;
      toast('Export saved.', { kind: 'success', action: { label: 'Show', run: () => void api.app.showItemInFolder(path) } });
    } else if (render.state === 'done' && !onVideoPage) {
      const projectId = render.projectId;
      toast('Your video is ready.', { kind: 'success', action: { label: 'View', run: () => void navigate({ page: 'video', projectId }) } });
    }
  }, [render, onVideoPage]);

  const rendering = !!render && renderActive(render) && !onVideoPage;
  // The Assets page shows its own progress.
  const adding = importing && route.page !== 'assets' ? importing : null;
  if (!rendering && !adding) return null;
  return (
    <div className="render-toasts">
      {adding && (
        <div className="render-toast" role="status">
          <span className="truncate">
            Adding {adding.name} ({adding.done + 1} of {adding.total})
          </span>
          <ProgressBar value={(adding.done + 0.5) / adding.total} />
        </div>
      )}
      {rendering && (
        <div className="render-toast" role="status">
          <div className="row">
            <strong className="grow tabular">
              Exporting {Math.round(render.progress * 100)}%
            </strong>
            <Button size="small" variant="ghost" onClick={() => void api.render.cancel()}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={render.progress} />
        </div>
      )}
    </div>
  );
}
