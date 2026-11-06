import type { SessionWidget } from './types';

export default function SessionWidgets({
  widgets,
  placement,
}: {
  widgets: SessionWidget[];
  placement: 'aboveEditor' | 'belowEditor';
}) {
  if (widgets.length === 0) return null;

  return (
    <>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          data-testid={`session-widget-${widget.key}`}
          data-placement={placement}
          className="border border-[#00B4FF]/50 bg-[#001018] px-2 py-1 text-xs text-[#00B4FF]"
        >
          {widget.lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}