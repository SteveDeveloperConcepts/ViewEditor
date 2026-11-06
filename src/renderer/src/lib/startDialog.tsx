// "Let's make a video": how a project starts from your own footage. Nothing exists until there is
// something to put in it, so closing this dialog leaves nothing behind.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Clapperboard, Smartphone, Speech, Upload } from 'lucide-react';
import type { ImportResult } from '@shared/types';
import { Modal } from '@/components/Modal';
import { droppedPaths, hasFiles, reportRejected, SUPPORTED_SUMMARY } from '@/editor/importing';
import { openSpeechDialog } from '@/editor/panels/SpeechDialog';
import { openPhoneDialog } from '@/editor/PhoneDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { showModal, toast } from '@/store/ui';
import { api, errorMessage } from './api';
import { startBlankProject, startProjectWith, type ProjectPlace } from './projects';

function StartBody({ place, close }: { place: ProjectPlace; close: () => void }): ReactNode {
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
        <strong>Upload files</strong>
        <span>Choose files or drag them here</span>
        <span className="faint">{SUPPORTED_SUMMARY}</span>
      </div>
      <div className="welcome-options">
        <button type="button" className="welcome-option" onClick={then(() => openPhoneDialog(null, place))}>
          <Smartphone size={20} />
          <strong>Upload from phone</strong>
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
