import type { ReactNode } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

export const ModalLayout = Object.freeze({
  card: 'card',
  full: 'full',
} as const);
export type ModalLayout = (typeof ModalLayout)[keyof typeof ModalLayout];

export const ModalSize = Object.freeze({
  md: 'md',
  lg: 'lg',
} as const);
export type ModalSize = (typeof ModalSize)[keyof typeof ModalSize];

const OVERLAY_LAYOUT: Record<ModalLayout, string> = {
  [ModalLayout.card]: 'flex items-start justify-center overflow-y-auto p-4',
  [ModalLayout.full]: 'flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4',
};

const PANEL_LAYOUT: Record<ModalLayout, string> = {
  [ModalLayout.card]: 'my-auto w-full rounded-none border',
  [ModalLayout.full]: 'flex min-h-0 w-full flex-1 flex-col rounded-none border',
};

const PANEL_SIZE: Record<ModalSize, string> = {
  [ModalSize.md]: 'max-w-xl',
  [ModalSize.lg]: 'max-w-3xl',
};

const HEADER_LAYOUT: Record<ModalLayout, string> = {
  [ModalLayout.card]: 'flex flex-wrap items-center gap-3',
  [ModalLayout.full]: 'flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4',
};

const BODY_LAYOUT: Record<ModalLayout, string> = {
  [ModalLayout.card]: '',
  [ModalLayout.full]: 'min-h-0 flex-1',
};

const CLOSE_BUTTON =
  'ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00] transition-base';

export interface ModalShellClasses {
  overlay?: string;
  card?: string;
  header?: string;
  body?: string;
  footer?: string;
}

export interface ModalShellProps {
  onClose: () => void;
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  layout?: ModalLayout;
  size?: ModalSize;
  showClose?: boolean;
  dialogLabel?: string;
  closeTestId?: string;
  overlayTestId?: string;
  cardTestId?: string;
  classes?: ModalShellClasses;
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export default function ModalShell({
  onClose,
  title,
  actions,
  children,
  footer,
  layout = ModalLayout.card,
  size = 'lg',
  showClose = true,
  dialogLabel,
  closeTestId,
  overlayTestId,
  cardTestId,
  classes = {},
}: ModalShellProps) {
  useEscapeKey(true, onClose);

  const resolvedLayout: ModalLayout = layout;
  const hasHeader = title != null || showClose || actions != null;

  return (
    <div
      data-testid={overlayTestId}
      className={cx(
        'fixed inset-0 z-50',
        OVERLAY_LAYOUT[resolvedLayout],
        classes.overlay,
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        data-testid={cardTestId}
        className={cx(
          PANEL_LAYOUT[resolvedLayout],
          resolvedLayout === ModalLayout.card ? PANEL_SIZE[size] : false,
          classes.card,
        )}
      >
        {hasHeader && (
          <header
            className={cx(HEADER_LAYOUT[resolvedLayout], classes.header)}
          >
            {resolvedLayout === ModalLayout.card ? (
              <div className="min-w-0 flex-1">{title}</div>
            ) : (
              title
            )}
            {actions}
            {showClose && (
              <button
                type="button"
                data-testid={closeTestId}
                aria-label="Закрыть"
                onClick={onClose}
                className={CLOSE_BUTTON}
              >
                ✕
              </button>
            )}
          </header>
        )}
        <div className={cx(BODY_LAYOUT[resolvedLayout], classes.body)}>
          {children}
        </div>
        {footer != null && <div className={classes.footer}>{footer}</div>}
      </div>
    </div>
  );
}