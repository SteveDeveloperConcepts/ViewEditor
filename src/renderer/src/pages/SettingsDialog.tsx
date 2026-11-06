// App settings, and the help sheet.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { FolderOpen, Laptop, Moon, Sparkles, Sun } from 'lucide-react';
import { formatBytes } from '@shared/time';
import type { ThemeSetting } from '@shared/types';
import { openConnections } from '@/ai/ConnectionsDialog';
import { Modal } from '@/components/Modal';
import { Button, Segmented } from '@/components/ui';
import { api, MOD_LABEL } from '@/lib/api';
import { useLibrary } from '@/store/library';
import { showModal } from '@/store/ui';

function SettingsBody({ close }: { close: () => void }): ReactNode {
  const settings = useLibrary((s) => s.lib!.settings);
  const info = useLibrary((s) => s.info);
  const [usage, setUsage] = useState<number | null>(null);

  useEffect(() => {
    void api.app.storageUsage().then(setUsage);
  }, []);

  return (
    <Modal title="Settings" size="wide" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="field">
        <span className="label">Appearance</span>
        <Segmented<ThemeSetting>
          label="Appearance"
          value={settings.theme}
          options={[
            { value: 'system', label: <><Laptop size={13} /> System</> },
            { value: 'light', label: <><Sun size={13} /> Light</> },
            { value: 'dark', label: <><Moon size={13} /> Dark</> },
          ]}
          onChange={(theme) => void api.library.updateSettings({ theme })}
        />
      </div>
      <div className="field">
        <span className="label">AI</span>
        <div className="row">
          <span className="grow faint">Your keys for AI video services and for Claude are all in one place.</span>
          <Button
            size="small"
            icon={<Sparkles size={13} />}
            onClick={() => {
              close();
              void openConnections();
            }}
          >
            AI connections
          </Button>
        </div>
      </div>
      <div className="field">
        <span className="label">Library</span>
        <div className="row">
          <span className="grow faint truncate selectable" title={info?.libraryPath}>
            {info?.libraryPath}
          </span>
          <span className="muted tabular">{usage === null ? '…' : formatBytes(usage)}</span>
          <Button size="small" icon={<FolderOpen size={13} />} onClick={() => void api.app.openLibraryFolder()}>
            Open
          </Button>
        </div>
      </div>
      <p className="faint">
        {info?.name} {info?.version}
      </p>
    </Modal>
  );
}

export function openSettings(): void {
  void showModal<void>((close) => <SettingsBody close={() => close()} />);
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play or pause'],
  ['S', 'Split at the playhead'],
  ['Delete', 'Delete the selected clips, or close a selected gap'],
  ['← →', 'Move one frame'],
  ['Shift + ← →', 'Move one second'],
  ['Home / End', 'Go to the start or the end'],
  ['+ / −', 'Zoom the timeline'],
  [`${MOD_LABEL} + wheel`, 'Zoom around the pointer'],
  [`${MOD_LABEL} + click`, 'Select several clips'],
  [`${MOD_LABEL} + Z`, 'Undo'],
  [`${MOD_LABEL} + Shift + Z`, 'Redo'],
  [`${MOD_LABEL} + C / X / V`, 'Copy, cut, paste'],
  [`${MOD_LABEL} + D`, 'Duplicate'],
  [`${MOD_LABEL} + G`, 'Group'],
  [`${MOD_LABEL} + Shift + G`, 'Ungroup'],
  ['Alt while dragging', 'Turn snapping off'],
  [`${MOD_LABEL} + K`, 'How do I… and search for an action'],
];

export function openShortcuts(): void {
  void showModal<void>((close) => (
    <Modal title="Keyboard shortcuts" onClose={() => close()}>
      <div className="shortcut-list">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="field-row">
            <span className="kbd">{keys}</span>
            <span className="muted">{what}</span>
          </div>
        ))}
      </div>
    </Modal>
  ));
}
