import { TABS, type Tab } from './routing';

interface MobileNavProps {
  activeTab: Tab;
  onTabClick: (tab: Tab) => void;
}

export default function MobileNav({ activeTab, onTabClick }: MobileNavProps) {
  return (
    <nav
      aria-label="Мобильная навигация"
      data-testid="mobile-nav"
      className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-[#008F11]/40 bg-[#0D0208] sm:hidden"
    >
      {TABS.map(({ tab, label }) => {
        const active = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={[
              'flex-1 py-3 text-xs font-medium transition-colors',
              active
                ? 'text-[#00FF41]'
                : 'text-[#00FF41]/50 hover:text-[#00FF41]/80',
            ].join(' ')}
            onClick={() => onTabClick(tab)}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
