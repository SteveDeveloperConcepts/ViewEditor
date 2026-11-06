// Brand kits inside the editor: logos go on the canvas, colours and fonts apply to the selected text.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import type { TextItem } from '@shared/types';
import { Button } from '@/components/ui';
import { loadBrandFonts } from '@/lib/fonts';
import { addAsset, addText, selectedItems, updateSettings, updateText } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { navigate } from '@/store/ui';
import { AssetTile } from './MediaPanel';

function selectedText(): TextItem | null {
  const items = selectedItems();
  return items.length === 1 && items[0].type === 'text' ? items[0] : null;
}

export function BrandPanel(): ReactNode {
  const kits = useLibrary((s) => s.lib?.brandKits) ?? [];
  const assets = useLibrary((s) => s.assetsById);
  const [kitId, setKitId] = useState<string | null>(null);
  const kit = kits.find((k) => k.id === kitId) ?? kits[0];

  useEffect(() => {
    void loadBrandFonts(kits);
  }, [kits]);

  if (!kit) {
    return (
      <div className="panel-body">
        <h2 className="panel-title">Brand Kit</h2>
        <div className="empty small">
          <div className="empty-icon">
            <Palette size={20} />
          </div>
          <p>Keep your logos, colours and fonts in one place and use them in any project.</p>
          <Button onClick={() => void navigate({ page: 'brand' })}>Create a brand kit</Button>
        </div>
      </div>
    );
  }

  const applyColor = (color: string): void => {
    const text = selectedText();
    if (text) updateText(text.id, { style: { color } });
    else updateSettings({ background: color });
  };

  return (
    <div className="panel-body">
      <h2 className="panel-title">Brand Kit</h2>
      {kits.length > 1 && (
        <select className="select" aria-label="Brand kit" value={kit.id} onChange={(e) => setKitId(e.target.value)}>
          {kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      )}
      <section>
        <h3>Logos</h3>
        {kit.logoAssetIds.length ? (
          <div className="asset-grid">
            {kit.logoAssetIds.map((id) => {
              const a = assets[id];
              return a ? <AssetTile key={id} asset={a} onAdd={(asset) => void addAsset(asset)} /> : null;
            })}
          </div>
        ) : (
          <p className="faint">No logos in this kit yet.</p>
        )}
      </section>
      <section>
        <h3>Colours</h3>
        {kit.colors.length ? (
          <>
            <div className="swatches">
              {kit.colors.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} title={c} aria-label={`Use ${c}`} onClick={() => applyColor(c)} />
              ))}
            </div>
            <p className="faint panel-note">Applies to the selected text, or to the canvas background when no text is selected.</p>
          </>
        ) : (
          <p className="faint">No colours in this kit yet.</p>
        )}
      </section>
      <section>
        <h3>Fonts</h3>
        {kit.fonts.length ? (
          <div className="col">
            {kit.fonts.map((f) => (
              <button
                key={f.id}
                type="button"
                className="text-basic"
                style={{ fontFamily: `"${f.family}"`, fontSize: 18 }}
                onClick={() => {
                  const text = selectedText();
                  if (text) updateText(text.id, { style: { fontFamily: f.family } });
                  else addText('subheading', { fontFamily: f.family });
                }}
              >
                {f.family}
              </button>
            ))}
          </div>
        ) : (
          <p className="faint">No fonts in this kit yet.</p>
        )}
      </section>
      <Button variant="ghost" size="small" onClick={() => void navigate({ page: 'brand' })}>
        Manage brand kits
      </Button>
    </div>
  );
}
