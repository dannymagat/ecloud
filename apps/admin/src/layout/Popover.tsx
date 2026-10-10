/**
 * Disclosure popover for the top bar (organization / site chips, user menu): a button with
 * `aria-expanded` that reveals a panel of links or buttons. Escape, choosing an entry (the
 * caller's `close`) and a click outside close it and return focus to the button (a click outside
 * keeps focus on whatever focusable element was clicked). Moving focus out of it (Tab) closes it
 * and leaves focus where it went.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../components/ui';

export function Popover({
  label,
  buttonContent,
  buttonClassName,
  align = 'left',
  panelLabel,
  children,
}: {
  /** Accessible name of the button when its content alone is not explicit. */
  label?: string;
  buttonContent: ReactNode;
  buttonClassName?: string;
  align?: 'left' | 'right';
  panelLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        // After the click settles: nothing focusable was clicked → back to the trigger.
        window.setTimeout(() => {
          if (document.activeElement === document.body || document.activeElement === null) {
            button.current?.focus();
          }
        }, 0);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Called from event handlers only (an entry was chosen): close, then back to the trigger.
  function closeAndRefocus() {
    setOpen(false);
    document.getElementById(buttonId)?.focus();
  }

  return (
    <div
      ref={root}
      className="relative min-w-0"
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget) && e.relatedTarget) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        id={buttonId}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
          buttonClassName,
        )}
      >
        {buttonContent}
      </button>
      {open ? (
        <div
          id={id}
          role="group"
          aria-label={panelLabel}
          className={cx(
            'absolute top-full z-50 mt-1 max-h-[70vh] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-surface py-1 text-sm shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(closeAndRefocus)}
        </div>
      ) : null}
    </div>
  );
}

/** One entry of a popover panel (button or link look-alike). */
export const popoverItemClass = (current = false) =>
  cx(
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
    current ? 'bg-primary/10 font-semibold text-primary' : 'text-fg hover:bg-muted',
  );
