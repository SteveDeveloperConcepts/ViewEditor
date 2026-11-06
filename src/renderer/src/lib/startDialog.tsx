// "Let's make a video": how a project starts from your own footage. Nothing exists until there is
// something to put in it, so closing this dialog leaves nothing behind.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Clapperboard, Smartphone, Speech, Upload } from 'lucide-react';
import type { ImportResult } from '@shared/types';
import { Modal } from '@/components/Modal';
import { droppedPaths, hasFiles, reportRejected, SUPPORTED_SUMMARY } from '@/editor/importing';
import { AssetTile } from '@/editor/panels/MediaPanel';
import { openSpeechDialog } from '@/editor/panels/SpeechDialog';
import { openPhoneDialog } from '@/editor/PhoneDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { useLibrary } from '@/store/library';
import { showModal, toast } from '@/store/ui';
import { api, errorMessage } from './api';
import { startBlankProject, startProjectWith, type ProjectPlace } from './projects';

function StartBody({ place, close }: { place: ProjectPlace; close: () => void }): ReactNode {
  const assets = useLibrary((s) => s.lib?.assets);
  // Footage first, since that is what a project usually starts from, and never sound taken from it.
  const recent = useMemo(() => {
    const usable = (assets ?? []).filter((a) => a.source !== 'extracted').reverse();
    return [...usable.filter((a) => a.kind === 'video'), ...usable.filter((a) => a.kind !== 'video')].slice(0, 4);
  }, [assets]);
  const [over, setOver] = useState(false);
  const then = (action: () => void) => () => {
    close();
    action();
  };

  const begin = async (bring: () => Promise<ImportResult | null>): Promise<void> => {
    try {
      const result = await bring();
      if (!result) return;
      reportRejected(result);
      if (!result.assets.length) return;
      close();
      await startProjectWith(result.assets, place);
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };
  const pick = (): Promise<void> => begin(() => api.assets.pickAndImport('media', { scope: 'workspace' }));

  return (
    <Modal title="Let's make a video" size="wide" onClose={close}>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        data-autofocus
        onClick={() => void pick()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void pick();
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const paths = droppedPaths(e.dataTransfer);
          void begin(() => api.assets.importPaths(paths, { scope: 'workspace' }));
        }}
      >
        <div className="dz-icon">
          <Upload size={18} />
        </div>
        <strong>Add files</strong>
        <span>Choose files or drag them here</span>
        <span className="faint">{SUPPORTED_SUMMARY}</span>
      </div>
      <div className="welcome-options">
        <button type="button" className="welcome-option" onClick={then(() => openPhoneDialog(null, place))}>
          <Smartphone size={20} />
          <strong>Add from phone</strong>
          <span>Send files over Wi-Fi</span>
        </button>
        <button type="button" className="welcome-option" onClick={then(() => void openRecorder({}))}>
          <Clapperboard size={20} />
          <strong>Start by recording</strong>
          <span>Screen, camera or both</span>
        </button>
        <button type="button" className="welcome-option" onClick={then(() => openSpeechDialog(null, place))}>
          <Speech size={20} />
          <strong>Start with a script</strong>
          <span>Turn text into a voice-over</span>
        </button>
      </div>
      {recent.length > 0 && (
        <section className="welcome-media">
          <h3>From your media</h3>
          <div className="asset-grid wide">
            {recent.map((a) => (
              <AssetTile
                key={a.id}
                asset={a}
                hint="Click to start a project with this"
                onAdd={(chosen) => {
                  close();
                  void startProjectWith([chosen], place).catch((err) => toast(errorMessage(err), { kind: 'error' }));
                }}
              />
            ))}
          </div>
        </section>
      )}
      <button type="button" className="link-btn welcome-blank" onClick={then(() => void startBlankProject(place))}>
        Start with an empty project
      </button>
    </Modal>
  );
}

/** Files dropped on the dashboard: the same thing as choosing them in the start dialog. */
export async function startFromFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    const result = await api.assets.importPaths(paths, { scope: 'workspace' });
    reportRejected(result);
    await startProjectWith(result.assets);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

export function openStartDialog(place: ProjectPlace = {}): void {
  void showModal<void>((close) => <StartBody place={place} close={() => close()} />);
}
