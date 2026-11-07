import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/update';
import { saveAndThumbnail } from '@/editor/save';
import { api, errorMessage } from '@/lib/api';
import { renderActive, useLibrary } from '@/store/library';
import { toast } from '@/store/ui';
import { Button } from './ui';

/** What the notice says, and what its buttons are called. */
function wording(update: UpdateState): { title: string; detail: string; action: string; dismiss: string } {
  switch (update.kind) {
    case 'ready':
      return {
        title: `ViewEditor ${update.version} is ready to install`,
        detail: 'It installs the next time you quit ViewEditor. Restart now to start using it.',
        action: 'Restart now',
        dismiss: 'Later',
      };
    case 'available':
      return {
        title: `ViewEditor ${update.version} is available`,
        detail: 'Download it from the release page, then drag it into Applications to replace this copy.',
        action: 'Download',
        dismiss: 'Later',
      };
    case 'move':
      return {
        title: 'Move ViewEditor to Applications to keep it up to date',
        detail: "It's running from somewhere it can't update itself, such as the disk image.",
        action: 'Move to Applications',
        dismiss: 'Not now',
      };
  }
}

/**
 * A newer ViewEditor, ready to install on restart or to download from its release page. On a Mac, a copy that
 * can't update itself where it is offers to move to Applications.
 */
export function UpdateBanner(): ReactNode {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  /** The notice the user put off: a version, or `move`. A newer version shows again. */
  const [later, setLater] = useState<string | null>(null);
  const rendering = useLibrary((s) => renderActive(s.render));

  useEffect(() => {
    void api.update.state().then((state) => {
      if (state) setUpdate(state);
    });
    return api.on('update:changed', setUpdate);
  }, []);

  if (!update) return null;
  const key = update.kind === 'move' ? 'move' : update.version;
  if (later === key) return null;
  // Restarting into a new version and moving to Applications both quit ViewEditor.
  const quits = update.kind !== 'available';
  const { title, detail, action, dismiss } = wording(update);

  const install = async (): Promise<void> => {
    try {
      // The app closes once this starts, so the open project is saved first.
      if (quits) await saveAndThumbnail();
      await api.update.install();
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <Button size="small" variant="ghost" onClick={() => setLater(key)}>
        {dismiss}
      </Button>
      <Button
        size="small"
        variant="primary"
        disabled={quits && rendering}
        title={quits && rendering ? 'Wait for the export to finish' : undefined}
        onClick={() => void install()}
      >
        {action}
      </Button>
    </div>
  );
}
