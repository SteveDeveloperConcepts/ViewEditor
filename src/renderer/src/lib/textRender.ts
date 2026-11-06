// Text layout and drawing. The editor preview, the project thumbnail and the export all go through
// drawTextItem, so what is on the canvas is exactly what ends up in the video.
//
// Layout is always computed in project pixels and the canvas transform does the scaling. That keeps
// line breaks identical whether the text is drawn small in the preview or at 4K for export.

import type { TextItem, TextStyle } from '@shared/types';

let scratch: OffscreenCanvasRenderingContext2D | null = null;

function measurer(): OffscreenCanvasRenderingContext2D {
  scratch ??= new OffscreenCanvas(8, 8).getContext('2d')!;
  return scratch;
}

export function fontCss(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${style.fontSize}px "${style.fontFamily}", "Segoe UI", system-ui, sans-serif`;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  lineHeight: number;
  height: number;
  ascent: number;
  descent: number;
}

export function layoutText(text: string, style: TextStyle, boxWidth: number): TextLayout {
  const ctx = measurer();
  ctx.font = fontCss(style);
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent || style.fontSize * 0.9;
  const descent = metrics.fontBoundingBoxDescent || style.fontSize * 0.25;
  const lineHeight = style.fontSize * style.lineHeight;
  const width = (s: string): number => ctx.measureText(s).width;
  const source = style.uppercase ? text.toUpperCase() : text;

  const lines: string[] = [];
  for (const paragraph of source.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= boxWidth || !line) {
        line = candidate;
        // A single word wider than the box is broken wherever it has to be.
        while (width(line) > boxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && width(line.slice(0, cut)) > boxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return { lines, widths: lines.map(width), lineHeight, height: Math.max(1, lines.length) * lineHeight, ascent, descent };
}

/** Height a text box needs for its content. */
export function textHeight(text: string, style: TextStyle, boxWidth: number): number {
  return layoutText(text, style, boxWidth).height;
}

/** How far drawing can reach outside the text box (background padding, outline, shadow), in project pixels. */
export function textBleed(style: TextStyle): number {
  return Math.ceil(style.bgPadding + style.strokeWidth + style.fontSize * 0.3);
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draws a text item. `scale` converts project pixels to canvas pixels, and (originX, originY) is the
 * project-space point that maps to the canvas origin.
 */
export function drawTextItem(ctx: Ctx, item: TextItem, scale: number, originX = 0, originY = 0): void {
  const { style } = item;
  const layout = layoutText(item.text, style, item.w);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(item.x - originX, item.y - originY);
  ctx.globalAlpha = Math.max(0, Math.min(1, item.opacity));
  ctx.font = fontCss(style);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  const left = (i: number): number =>
    style.align === 'left' ? 0 : style.align === 'right' ? item.w - layout.widths[i] : (item.w - layout.widths[i]) / 2;

  if (style.bgColor) {
    ctx.fillStyle = style.bgColor;
    layout.lines.forEach((line, i) => {
      if (!line.trim()) return;
      ctx.beginPath();
      ctx.roundRect(left(i) - style.bgPadding, i * layout.lineHeight, layout.widths[i] + style.bgPadding * 2, layout.lineHeight, style.bgRadius);
      ctx.fill();
    });
  }

  const shadowOn = (): void => {
    // Shadow distances ignore the canvas transform, so they are scaled by hand.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = style.fontSize * 0.12 * scale;
    ctx.shadowOffsetY = style.fontSize * 0.04 * scale;
  };
  const shadowOff = (): void => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  const outlined = !!style.strokeColor && style.strokeWidth > 0;

  layout.lines.forEach((line, i) => {
    if (!line) return;
    const x = left(i);
    const y = i * layout.lineHeight + (layout.lineHeight - (layout.ascent + layout.descent)) / 2 + layout.ascent;
    if (outlined) {
      if (style.shadow) shadowOn();
      ctx.strokeStyle = style.strokeColor!;
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeText(line, x, y);
      shadowOff();
    } else if (style.shadow && !style.bgColor) {
      shadowOn();
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
    shadowOff();
  });
  ctx.restore();
}
