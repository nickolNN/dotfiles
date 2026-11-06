import type { ReactNode } from 'react';

interface PageNoticeProps {
  testId: string;
  className?: string;
  children: ReactNode;
}

export default function PageNotice({
  testId,
  className,
  children,
}: PageNoticeProps) {
  return (
    <p
      data-testid={testId}
      role="status"
      className={`border border-[#FFB000] px-3 py-2 text-sm text-[#FFB000]${className ? ` ${className}` : ''}`}
    >
      {children}
    </p>
  );
}