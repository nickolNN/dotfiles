import { useEffect, useState } from 'react';
import {
  subscribeToGlobalStream,
  type ContainerStatsPayload,
} from './api/sse';
import { formatBytes, healthColor } from './lib/containerStats';
import { API_BASE } from './api/client';
import NewIssue from './views/NewIssue';
import Repositories from './views/Repositories';
import Settings from './views/Settings';
import Tags from './views/Tags';
import TasksList from './views/TasksList';
import TaskDetail from './views/TaskDetail';

type View =
  | 'new-issue'
  | 'tasks'
  | 'task-detail'
  | 'repositories'
  | 'tags'
  | 'settings';

/** Верхние табы-разделы (форма создания задачи и деталь — под табом «Задачи»). */
type Tab = 'tasks' | 'repositories' | 'tags' | 'settings';

interface Route {
  view: View;
  issueId: string | null;
  openResult?: boolean;
}

function parseHash(hash: string = window.location.hash): Route {
  const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] === 'tasks') {
    return parts[1]
      ? {
          view: 'task-detail',
          issueId: decodeURIComponent(parts[1]),
          openResult: parts[2] === 'result',
        }
      : { view: 'tasks', issueId: null };
  }
  if (parts[0] === 'new') {
    return { view: 'new-issue', issueId: null };
  }
  if (parts[0] === 'repositories') {
    return { view: 'repositories', issueId: null };
  }
  if (parts[0] === 'tags') {
    return { view: 'tags', issueId: null };
  }
  if (parts[0] === 'settings') {
    return { view: 'settings', issueId: null };
  }
  // Пустой или неизвестный hash → главная страница со списком задач.
  return { view: 'tasks', issueId: null };
}

const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'tasks', label: 'Задачи' },
  { tab: 'repositories', label: 'Репозитории' },
  { tab: 'tags', label: 'Теги' },
];

const TAB_PATHS: Record<Exclude<Tab, 'settings'>, string> = {
  tasks: '/tasks',
  repositories: '/repositories',
  tags: '/tags',
};

/** Inline-иконка «плюс» для основной кнопки действия, без внешних зависимостей. */
function PlusIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * Блок живой статистики контейнера (CPU/память). Используется дважды: в
 * десктопном хедере (`suffix=""`) и в мобильной верхней строке
 * (`suffix="-mobile"`). Суффикс разводит data-testid'ы, иначе jsdom-mount
 * (без медиазапросов) давал бы дубли и `getByTestId` падал бы.
 */
function ContainerStatsBlock({
  stats,
  suffix,
  className,
}: {
  stats: ContainerStatsPayload | null;
  suffix: string;
  className?: string;
}) {
  const cpuPercent = stats?.cpuPercent ?? null;
  const memoryUsageBytes = stats?.memoryUsageBytes ?? null;
  const memoryLimitBytes = stats?.memoryLimitBytes ?? null;
  const memPercent =
    memoryUsageBytes != null && memoryLimitBytes
      ? (memoryUsageBytes / memoryLimitBytes) * 100
      : null;

  return (
    <div
      data-testid={`container-stats${suffix}`}
      className={[
        'flex items-center gap-3 font-mono text-xs text-[#00FF41]/60',
        className ?? '',
      ].join(' ')}
    >
      {stats && cpuPercent != null ? (
        <>
          <span className="flex items-center gap-1">
            <span
              data-testid={`cpu-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: healthColor(cpuPercent, 80) }}
            />
            {`CPU ${cpuPercent.toFixed(1)}%`}
          </span>
          <span className="flex items-center gap-1">
            <span
              data-testid={`mem-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: healthColor(memPercent ?? 0, 90) }}
            />
            {`MEM ${formatBytes(memoryUsageBytes ?? 0)}`}
          </span>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <span
              data-testid={`cpu-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full bg-[#00FF41]/20"
            />
            CPU —
          </span>
          <span className="flex items-center gap-1">
            <span
              data-testid={`mem-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full bg-[#00FF41]/20"
            />
            MEM —
          </span>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  // Растёт при клике «+» на табе «Репозитории» → Repositories открывает модалку.
  const [repoCreateSignal, setRepoCreateSignal] = useState(0);
  // Растёт при клике «+» на табе «Теги» → Tags открывает форму создания.
  const [tagCreateSignal, setTagCreateSignal] = useState(0);
  // Живая стата контейнера открытой задачи (CPU/память) для общего хедера.
  // Приходит по SSE `container_stats` из потока задачи.
  const [containerStats, setContainerStats] =
    useState<ContainerStatsPayload | null>(null);
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const selectedIssueId = route.issueId;

  // Глобальная подписка на `container_stats`: в local-режиме cgroup-метрики
  // читаются с хост-контейнера независимо от задачи, поэтому статы в хедере
  // живут на ВСЕХ страницах (список/репозитории/теги/форма), а не только на
  // детали задачи. Бэкенд публикует их с `issueId: '__global__'` через общий
  // `/stream`; фильтровать по issueId не нужно — в local-режиме метрики
  // одинаковы для любого источника (читается хост-контейнер).
  useEffect(() => {
    return subscribeToGlobalStream({
      onContainerStats: (payload) => setContainerStats(payload),
    });
  }, []);

  // Отдельный EventSource на глобальный `/container-stats-stream` управляет
  // жизненным циклом cgroup-потока: подключился клиент → бэкенд стартует
  // поток, отключился → останавливает. Данные из этого соединения не
  // читаются — события `container_stats` приходят через глобальный `/stream`.
  useEffect(() => {
    const EventSourceCtor = globalThis.EventSource;
    if (!EventSourceCtor) return;
    const src = new EventSourceCtor(`${API_BASE}/container-stats-stream`);
    src.onerror = () => src.close();
    return () => src.close();
  }, []);
  const view: View =
    route.view === 'task-detail' && !selectedIssueId ? 'tasks' : route.view;

  // «Репозитории»/«Теги» — отдельные табы; всё остальное (список, форма, деталь) — «Задачи».
  const activeTab: Tab =
    view === 'repositories'
      ? 'repositories'
      : view === 'tags'
        ? 'tags'
        : view === 'settings'
          ? 'settings'
          : 'tasks';

  function navigate(hashPath: string) {
    const target = hashPath.startsWith('#') ? hashPath : `#${hashPath}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    setRoute(parseHash(target));
  }

  function openTask(issueId: string) {
    navigate(`/tasks/${issueId}`);
  }

  function openResult(issueId: string) {
    navigate(`/tasks/${issueId}/result`);
  }

  const primaryLabel =
    activeTab === 'repositories'
      ? 'Добавить репозиторий'
      : activeTab === 'tags'
        ? 'Создать тег'
        : 'Создать задачу';

  function handleTabClick(tab: Tab) {
    if (tab === 'repositories') setRepoCreateSignal(0);
    if (tab === 'tags') setTagCreateSignal(0);
    navigate(tab === 'settings' ? '/settings' : TAB_PATHS[tab]);
  }

  function handlePrimaryAction() {
    if (activeTab === 'repositories') {
      navigate(TAB_PATHS.repositories);
      setRepoCreateSignal((tick) => tick + 1);
    } else if (activeTab === 'tags') {
      navigate(TAB_PATHS.tags);
      setTagCreateSignal((tick) => tick + 1);
    } else {
      navigate('/new');
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#0D0208] text-[#00FF41]">
      {/* Мобильная верхняя строка: статы + «+». На sm+ скрыта. */}
      <div
        data-testid="mobile-topbar"
        className="flex items-center justify-between gap-2 border-b border-[#008F11]/40 px-2 py-1 sm:hidden"
      >
        <ContainerStatsBlock stats={containerStats} suffix="-mobile" />
        <button
          type="button"
          data-testid="primary-action-mobile"
          aria-label={primaryLabel}
          title={primaryLabel}
          className="group inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full text-[#00FF41] transition-transform primary-action-btn"
          onClick={handlePrimaryAction}
        >
          <PlusIcon />
        </button>
      </div>

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
                  onClick={() => handleTabClick(tab)}
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
              onClick={() => navigate('/settings')}
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </nav>
          <ContainerStatsBlock
            stats={containerStats}
            suffix=""
            className="ml-auto mr-3"
          />
          <button
            type="button"
            data-testid="primary-action"
            aria-label={primaryLabel}
            title={primaryLabel}
            className="hidden min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full text-[#00FF41] transition-transform primary-action-btn sm:inline-flex"
            onClick={handlePrimaryAction}
          >
            <PlusIcon />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-2 pt-6 pb-12 sm:px-4 sm:pb-0 md:px-6">
        {view === 'new-issue' && (
          <NewIssue
            onCreated={(issue) => navigate(`/tasks/${issue.id}`)}
            onBack={() => navigate('/tasks')}
          />
        )}
        {view === 'repositories' && (
          <Repositories createSignal={repoCreateSignal} />
        )}
        {view === 'tags' && <Tags createSignal={tagCreateSignal} />}
        {view === 'settings' && <Settings />}
        {view === 'tasks' && (
          <TasksList onOpenTask={openTask} onOpenResult={openResult} />
        )}
        {view === 'task-detail' && (
          <>
            <TaskDetail issueId={selectedIssueId} autoOpenResult={route.openResult} />
          </>
        )}
      </main>

      {/* Мобильная нижняя навигация (табы). На sm+ скрыта. */}
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
              onClick={() => handleTabClick(tab)}
            >
              {label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}