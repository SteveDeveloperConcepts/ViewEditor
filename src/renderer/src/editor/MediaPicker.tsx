// Choosing something from Media, with a way to bring in a new file if it is not there yet.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import type { PickKind } from '@shared/api';
import type { Asset, AssetKind, ID } from '@shared/types';
import { Modal } from '@/components/Modal';
import { Button, EmptyState } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLibrary } from '@/store/library';
import { showModal, toast } from '@/store/ui';
import { reportRejected } from './importing';
import { AssetTile } from './panels/MediaPanel';

interface PickOptions {
  title: string;
  kinds: AssetKind[];
  /** What the file window should offer. */
  files: PickKind;
  /** Something that makes no sense to offer, such as what is being replaced. */
  exclude?: ID;
}

function PickerBody({ options, close }: { options: PickOptions; close: (asset?: Asset) => void }): ReactNode {
  const assets = useLibrary((s) => s.lib?.assets);
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (assets ?? []).filter((a) => options.kinds.includes(a.kind) && a.id !== options.exclude && (!q || a.name.toLowerCase().includes(q))).reverse();
  }, [assets, options, query]);

  const addFile = async (): Promise<void> => {
    try {
      const result = await api.assets.pickAndImport(options.files, { scope: 'workspace' });
      if (!result) return;
      reportRejected(result);
      const wanted = result.assets.find((a) => options.kinds.includes(a.kind));
      if (wanted) close(wanted);
      else if (result.assets.length) toast('That kind of file cannot be used here.', { kind: 'error' });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  return (
    <Modal
      title={options.title}
      size="wide"
      onClose={() => close()}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button icon={<Upload size={14} />} onClick={() => void addFile()}>
            Add from your computer
          </Button>
        </>
      }
    >
      <input className="input" placeholder="Search media" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
      {list.length ? (
        <div className="asset-grid wide">
          {list.map((a) => (
            <AssetTile key={a.id} asset={a} onAdd={close} hint="Click to choose this" />
          ))}
        </div>
      ) : (
        <EmptyState icon={<Upload size={22} />} title={query ? 'Nothing matches that search' : 'Nothing in Media yet'} />
      )}
    </Modal>
  );
}

/** Resolves with what was chosen, or undefined if the window was closed. */
export function pickFromMedia(options: PickOptions): Promise<Asset | undefined> {
  return showModal<Asset>((close) => <PickerBody options={options} close={close} />);
}
