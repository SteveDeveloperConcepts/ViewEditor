// Brand kits: logos, colours and fonts kept together for use in any project.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Ellipsis, Palette, Plus, Trash2, Type, Upload, X } from 'lucide-react';
import type { BrandKit } from '@shared/types';
import { openMenuAt } from '@/components/Menu';
import { confirmDialog, promptDialog } from '@/components/Modal';
import { Button, EmptyState, IconButton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { loadBrandFonts } from '@/lib/fonts';
import { assetUrl } from '@/lib/media';
import { reportRejected } from '@/editor/importing';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/ui';

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function KitEditor({ kit }: { kit: BrandKit }): ReactNode {
  const assets = useLibrary((s) => s.assetsById);
  const [color, setColor] = useState('#4f7cf5');

  const addLogos = (): void => {
    void attempt(async () => {
      const result = await api.assets.pickAndImport('image', { scope: 'workspace' });
      if (!result) return;
      reportRejected(result);
      await api.library.updateBrandKit(kit.id, { logoAssetIds: [...kit.logoAssetIds, ...result.assets.map((a) => a.id)] });
    });
  };

  const removeLogo = (id: string): void => {
    void attempt(() => api.library.updateBrandKit(kit.id, { logoAssetIds: kit.logoAssetIds.filter((x) => x !== id) }));
  };

  const addColor = (): void => {
    if (kit.colors.includes(color)) return;
    void attempt(() => api.library.updateBrandKit(kit.id, { colors: [...kit.colors, color] }));
  };

  return (
    <div className="kit-editor">
      <section>
        <div className="row">
          <h2 className="grow">Logos</h2>
          <Button size="small" icon={<Upload size={13} />} onClick={addLogos}>
            Add
          </Button>
        </div>
        {kit.logoAssetIds.length ? (
          <div className="kit-logos">
            {kit.logoAssetIds.map((id) => {
              const a = assets[id];
              if (!a) return null;
              return (
                <div key={id} className="kit-logo">
                  {a.hasThumb && <img src={assetUrl(a, 'thumb')} alt={a.name} draggable={false} />}
                  <IconButton small label={`Remove ${a.name}`} onClick={() => removeLogo(id)}>
                    <X size={13} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">PNG files with a transparent background work best.</p>
        )}
      </section>

      <section>
        <h2>Colours</h2>
        <div className="swatches large">
          {kit.colors.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              title={`${c} · click to remove`}
              aria-label={`Remove ${c}`}
              onClick={() => void attempt(() => api.library.updateBrandKit(kit.id, { colors: kit.colors.filter((x) => x !== c) }))}
            />
          ))}
        </div>
        <div className="row">
          <div className="color-field">
            <input type="color" aria-label="New colour" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          <Button size="small" icon={<Plus size={13} />} onClick={addColor}>
            Add colour
          </Button>
        </div>
      </section>

      <section>
        <div className="row">
          <h2 className="grow">Fonts</h2>
          <Button size="small" icon={<Upload size={13} />} onClick={() => void attempt(() => api.library.pickBrandFonts(kit.id))}>
            Add
          </Button>
        </div>
        {kit.fonts.length ? (
          <div className="col">
            {kit.fonts.map((f) => (
              <div key={f.id} className="kit-font">
                <span className="grow truncate" style={{ fontFamily: `"${f.family}"`, fontSize: 18 }}>
                  {f.family}
                </span>
                <IconButton small label={`Remove ${f.family}`} onClick={() => void attempt(() => api.library.removeBrandFont(kit.id, f.id))}>
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">TTF, OTF, WOFF and WOFF2 fonts can be used in any text.</p>
        )}
      </section>
    </div>
  );
}

export function BrandPage(): ReactNode {
  const kits = useLibrary((s) => s.lib?.brandKits) ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const kit = kits.find((k) => k.id === activeId) ?? kits[0];

  useEffect(() => {
    void loadBrandFonts(kits);
  }, [kits]);

  const create = (): void => {
    void promptDialog({ title: 'New brand kit', label: 'Name', placeholder: 'Acme', confirmLabel: 'Create' }).then((name) => {
      if (!name) return;
      void attempt(async () => {
        const made = await api.library.createBrandKit(name);
        setActiveId(made.id);
      });
    });
  };

  const kitMenu = (el: Element, k: BrandKit): void => {
    openMenuAt(
      el,
      [
        {
          label: 'Rename',
          icon: <Type size={15} />,
          onSelect: () => {
            void promptDialog({ title: 'Rename brand kit', label: 'Name', value: k.name }).then((name) => {
              if (name) void attempt(() => api.library.updateBrandKit(k.id, { name }));
            });
          },
        },
        {
          label: 'Delete',
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => {
            void confirmDialog({ title: `Delete “${k.name}”?`, message: 'Projects that already use its logos and fonts are not changed.', confirmLabel: 'Delete', danger: true }).then((ok) => {
              if (ok) void attempt(() => api.library.deleteBrandKit(k.id));
            });
          },
        },
      ],
      'end',
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Brand</h1>
        <div className="grow" />
        <Button variant="primary" icon={<Plus size={15} />} onClick={create}>
          New brand kit
        </Button>
      </header>
      {kit ? (
        <>
          <div className="kit-tabs">
            {kits.map((k) => (
              <div key={k.id} className="kit-tab" aria-selected={k.id === kit.id}>
                <button type="button" onClick={() => setActiveId(k.id)}>
                  {k.name}
                </button>
                <IconButton small label={`Options for ${k.name}`} onClick={(e) => kitMenu(e.currentTarget, k)}>
                  <Ellipsis size={15} />
                </IconButton>
              </div>
            ))}
          </div>
          <KitEditor key={kit.id} kit={kit} />
        </>
      ) : (
        <EmptyState icon={<Palette size={22} />} title="No brand kits yet">
          <p>Keep your logos, colours and fonts in one place, ready for every project.</p>
          <Button variant="primary" icon={<Plus size={15} />} onClick={create}>
            New brand kit
          </Button>
        </EmptyState>
      )}
    </div>
  );
}
