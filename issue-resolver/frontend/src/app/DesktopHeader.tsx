import type { ContainerStatsPayload } from '../api/sse';
import PlusIcon from '../components/icons/PlusIcon';
import ContainerStatsBlock from './ContainerStatsBlock';
import { TABS, type Tab } from './routing';

interface DesktopHeaderProps {
  activeTab: Tab;
  stats: ContainerStatsPayload | null;
  primaryLabel: string;
  onTabClick: (tab: Tab) => void;
  onNavigateSettings: () => void;
  onPrimary: () => void;
}

function SettingsIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export default function DesktopHeader({
  activeTab,
  stats,
  primaryLabel,
  onTabClick,
  onNavigateSettings,
  onPrimary,
}: DesktopHeaderProps) {
  return (
    <header
      data-testid="desktop-header"
      className="hidden border-b border-[#008F11]/40 sm:block"
    >
      <div className="mx-auto flex max-w-4xl items-center gap-2 px-2 py-2 sm:px-4 md:px-6">
        <nav
          data-testid="desktop-nav"
          aria-label="Основная навигация"
          className="flex min-w-0 flex-1 items-center gap-1"
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
                  'min-w-0 truncate rounded-none border-b-2 px-2 py-2 text-sm font-medium transition-colors sm:px-3',
                  active
                    ? 'border-[#00FF41] text-[#00FF41]'
                    : 'border-transparent text-[#00FF41]/50 hover:text-[#00FF41]/80',
                ].join(' ')}
                onClick={() => onTabClick(tab)}
              >
                {label}
              </button>
            );
          })}
          <button
            type="button"
            title="Настройки"
            aria-label="Настройки"
            className={[
              'ml-auto rounded-none border-b-2 px-2 py-2 text-sm font-medium transition-colors sm:px-3',
              activeTab === 'settings'
                ? 'border-[#00FF41] text-[#00FF41]'
                : 'border-transparent text-[#00FF41]/50 hover:text-[#00FF41]/80',
            ].join(' ')}
            onClick={onNavigateSettings}
          >
            <SettingsIcon />
          </button>
        </nav>
        <ContainerStatsBlock
          stats={stats}
          suffix=""
          className="ml-auto mr-3"
        />
        <button
          type="button"
          data-testid="primary-action"
          aria-label={primaryLabel}
          title={primaryLabel}
          className="hidden min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full text-[#00FF41] transition-transform primary-action-btn sm:inline-flex"
          onClick={onPrimary}
        >
          <PlusIcon className="h-5 w-5 shrink-0" />
        </button>
      </div>
    </header>
  );
}
