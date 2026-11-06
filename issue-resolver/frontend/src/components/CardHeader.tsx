import type { ReactNode } from 'react';

interface CardHeaderProps {
  title: ReactNode;
  titleTestId: string;
  leading?: ReactNode;
  actions: ReactNode;
  actionsClassName?: string;
}

export default function CardHeader({
  title,
  titleTestId,
  leading,
  actions,
  actionsClassName = 'gap-2',
}: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <div
          data-testid={titleTestId}
          className="truncate text-sm font-bold text-[#00FF41]"
        >
          {title}
        </div>
      </div>
      <div className={`flex shrink-0 items-center ${actionsClassName}`}>
        {actions}
      </div>
    </div>
  );
}
