// "Upload from phone": shows a QR code for a page served on the local network.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Wifi } from 'lucide-react';
import type { PhoneSession } from '@shared/api';
import type { ID } from '@shared/types';
import { Modal } from '@/components/Modal';
import { Button, Notice, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { showModal } from '@/store/ui';
import { addToTimeline, reportRejected } from './importing';

function PhoneBody({ projectId, close }: { projectId: ID | null; close: () => void }): ReactNode {
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [error, setError] = useState('');
  const [received, setReceived] = useState<string[]>([]);

  useEffect(() => {
    const target = projectId ? ({ scope: 'project', projectId } as const) : ({ scope: 'workspace' } as const);
    api.phone.start(target).then(setSession, (err) => setError(errorMessage(err)));
    const off = api.on('phone:received', (result) => {
      reportRejected(result);
      setReceived((r) => [...r, ...result.assets.map((a) => a.name)]);
      if (projectId) void addToTimeline(result.assets);
    });
    return () => {
      off();
      void api.phone.stop();
    };
  }, [projectId]);

  return (
    <Modal title="Upload from phone" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      {error ? (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      ) : !session ? (
        <div className="row">
          <Spinner /> <span className="muted">Starting…</span>
        </div>
      ) : (
        <>
          <p>Scan this code with your phone's camera, then choose the files to send. Your phone must be on the same Wi-Fi network as this computer.</p>
          <div className="qr">
            <svg viewBox={`-2 -2 ${session.qr.size + 4} ${session.qr.size + 4}`} role="img" aria-label="QR code for the upload page">
              <rect x="-2" y="-2" width={session.qr.size + 4} height={session.qr.size + 4} fill="#fff" />
              <path d={session.qr.path} fill="#000" />
            </svg>
          </div>
          <p className="selectable faint qr-url">{session.url}</p>
          <Notice icon={<Wifi size={14} />}>Files go straight to this computer. The page stops working as soon as you close this window.</Notice>
          {received.length > 0 && (
            <div className="col">
              {received.map((name, i) => (
                <div key={i} className="row">
                  <CircleCheck size={14} color="var(--success)" /> <span className="truncate">{name}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function openPhoneDialog(projectId: ID | null): void {
  void showModal<void>((close) => <PhoneBody projectId={projectId} close={() => close()} />);
}
