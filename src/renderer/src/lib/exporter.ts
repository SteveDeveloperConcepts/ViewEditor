// Starts an export. Text layers are drawn here, with the same code as the preview, and handed to
// the main process as pictures; ffmpeg composites them over the footage.

import { BLANK_OVERLAY, fullWindow, listOverlayFiles, planLayers, resolveOutputSpec, type ExportFormat, type TimeWindow } from '@shared/render';
import type { ProjectDoc } from '@shared/types';
import { getAssets } from '@/store/library';
import { api } from './api';
import { fontsReady } from './fonts';
import { canvasBytes } from './media';
import { drawTextItem } from './textRender';

export interface RenderRequest {
  kind: 'export' | 'section';
  /** Part of the timeline to render; the whole project when omitted. */
  window?: TimeWindow;
  /** File name offered when a section is saved. */
  suggestedName?: string;
  format?: ExportFormat;
}

/**
 * Kicks off a render and returns once it is running (progress then arrives as events).
 * Resolves to false when the user cancelled the "save as" dialog of a section.
 */
export async function startRender(doc: ProjectDoc, request: RenderRequest): Promise<boolean> {
  const window = request.window ?? fullWindow(doc);
  const spec = resolveOutputSpec(doc, getAssets());
  if (window.end - window.start < 1 / spec.fps) {
    throw new Error('There is nothing to export yet. Add something to the timeline first.');
  }
  const begun = await api.render.begin(doc.id, request.kind, request.suggestedName, request.format);
  if (!begun) return false;
  try {
    // Sound has no use for text.
    const files = request.format === 'mp3' ? [] : listOverlayFiles(planLayers(doc, window));
    if (files.length) {
      await fontsReady();
      const canvas = new OffscreenCanvas(spec.width, spec.height);
      const ctx = canvas.getContext('2d')!;
      await api.render.putOverlay(begun.jobId, BLANK_OVERLAY, await canvasBytes(canvas, 'image/png'));
      const scale = spec.width / doc.settings.width;
      const byId = new Map(doc.items.map((it) => [it.id, it]));
      for (const file of files) {
        ctx.clearRect(0, 0, spec.width, spec.height);
        for (const id of file.itemIds) {
          const item = byId.get(id);
          if (item?.type === 'text') drawTextItem(ctx, item, scale);
        }
        await api.render.putOverlay(begun.jobId, file.file, await canvasBytes(canvas, 'image/png'));
      }
    }
    await api.render.run(begun.jobId, { doc, window, spec });
    return true;
  } catch (err) {
    await api.render.cancel().catch(() => undefined);
    throw err;
  }
}
