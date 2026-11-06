import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { showModal, useUi } from '@/store/ui';
import { Button, IconButton } from './ui';

export function Modal(props: {
  title: string;
  onClose: () => void;
  size?: 'normal' | 'wide' | 'xwide';
  children: ReactNode;
  footer?: ReactNode;
  /** When false, clicking outside or pressing Escape does nothing (for work in progress). */
  dismissable?: boolean;
}): ReactNode {
  const { title, onClose, size = 'normal', children, footer, dismissable = true } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Put the keyboard inside the dialog: the first field if there is one, otherwise the dialog itself.
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), textarea, select');
    (first ?? ref.current)?.focus();
    return () => {
      // Deferred so the key press that closed the dialog cannot reach the element getting focus back.
      requestAnimationFrame(() => previous?.focus?.());
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal${size === 'normal' ? '' : ` ${size}`}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && dismissable) {
            e.stopPropagation();
            onClose();
          }
          // Keys typed in a dialog belong to the dialog, not to the editor underneath.
          e.stopPropagation();
        }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissable && (
            <IconButton label="Close" onClick={onClose}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ModalHost(): ReactNode {
  const modals = useUi((s) => s.modals);
  return <>{modals.map((m) => <div key={m.id}>{m.render((result) => m.resolve(result))}</div>)}</>;
}

export function confirmDialog(opts: { title: string; message: ReactNode; confirmLabel: string; danger?: boolean; cancelLabel?: string }): Promise<boolean> {
  return showModal<boolean>((close) => (
    <Modal
      title={opts.title}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>{opts.cancelLabel ?? 'Cancel'}</Button>
          <Button variant={opts.danger ? 'danger' : 'primary'} data-autofocus onClick={() => close(true)}>
            {opts.confirmLabel}
          </Button>
        </>
      }
    >
      <p>{opts.message}</p>
    </Modal>
  )).then((r) => r === true);
}

function PromptBody(props: { opts: PromptOptions; close: (v?: string) => void }): ReactNode {
  const { opts, close } = props;
  const [value, setValue] = useState(opts.value ?? '');
  const valid = value.trim().length > 0;
  const submit = (): void => {
    if (valid) close(value.trim());
  };
  return (
    <Modal
      title={opts.title}
      onClose={() => close(undefined)}
      footer={
        <>
          <Button onClick={() => close(undefined)}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {opts.confirmLabel ?? 'Save'}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="label">{opts.label}</span>
        <input
          className="input"
          value={value}
          maxLength={120}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Without this, the same key press would go on to "click" whatever takes focus next,
              // which is usually the button that opened this dialog.
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
      {opts.note && <p>{opts.note}</p>}
    </Modal>
  );
}

interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  note?: ReactNode;
}

/** Asks for a short piece of text. Resolves with null when cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return showModal<string>((close) => <PromptBody opts={opts} close={close} />).then((r) => r ?? null);
}
