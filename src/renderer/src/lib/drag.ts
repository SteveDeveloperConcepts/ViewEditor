/**
 * Follows the pointer from a pointer-down until it is released, wherever it goes.
 * Listeners sit on the window so the drag survives the dragged element being re-rendered.
 * Pressing Escape cancels: `onEnd` is called with `cancelled` set.
 */
export function trackPointer(onMove: (ev: PointerEvent) => void, onEnd: (ev: PointerEvent | null, cancelled: boolean) => void): void {
  const finish = (ev: PointerEvent | null, cancelled: boolean): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    onEnd(ev, cancelled);
  };
  const up = (ev: PointerEvent): void => finish(ev, false);
  const cancel = (ev: PointerEvent): void => finish(ev, true);
  const key = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      finish(null, true);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}
