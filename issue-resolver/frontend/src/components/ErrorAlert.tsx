import type { ReactNode } from 'react';

const DEFAULT_CLASS =
  'border border-[#FF0033] bg-[#2A0008] px-2 py-1 text-xs text-[#FF0033]';

interface ErrorAlertProps {
  children: ReactNode;
  testId?: string;
  className?: string;
}

export default function ErrorAlert({
  children,
  testId,
  className,
}: ErrorAlertProps) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`${DEFAULT_CLASS}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}