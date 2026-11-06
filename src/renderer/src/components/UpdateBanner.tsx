import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/update';
import { saveAndThumbnail } from '@/editor/EditorPage';
import { api } from '@/lib/api';
import { renderActive, useLibrary } from '@/store/library';
import { toast } from '@/store/ui';
import { Button } from './ui';

/** A newer ViewEditor: ready to install on restart (Windows), or to download from its release page (macOS). */
export function UpdateBanner(): ReactNode {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  /** The version the user put off. A newer one shows again. */
  const [later, setLater] = useState<string | null>(null);
  const rendering = useLibrary((s) => renderActive(s.render));

  useEffect(() => {
    void api.update.state().then((state) => {
      if (state) setUpdate(state);
    });
    return api.on('update:changed', setUpdate);
  }, []);

  if (!update || later === update.version) return null;
  const ready = update.kind === 'ready';

  const install = async (): Promise<void> => {
    try {
      // The installer starts before the app closes, so the open project is saved first.
      if (ready) await saveAndThumbnail();
      await api.update.install();
    } catch (err) {
      toast((err as Error).message, { kind: 'error' });
    }
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <strong>
          ViewEditor {update.version} is {ready ? 'ready to install' : 'available'}
        </strong>
        <span>
          {ready
            ? 'It installs the next time you quit ViewEditor. Restart now to start using it.'
            : 'Download it from the release page, then drag it into Applications to replace this copy.'}
        </span>
      </div>
      <Button size="small" variant="ghost" onClick={() => setLater(update.version)}>
        Later
      </Button>
      <Button
        size="small"
        variant="primary"
        disabled={ready && rendering}
        title={ready && rendering ? 'Wait for the export to finish' : undefined}
        onClick={() => void install()}
      >
        {ready ? 'Restart now' : 'Download'}
      </Button>
    </div>
  );
}
