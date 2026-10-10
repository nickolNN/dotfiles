import { useEffect, useState } from 'react';
import NewIssue from './views/NewIssue';
import TasksList from './views/TasksList';
import TaskDetail from './views/TaskDetail';

type View = 'new-issue' | 'tasks' | 'task-detail';

type NavView = 'new-issue' | 'tasks';

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
  // Пустой или неизвестный hash → главная страница со списком задач.
  return { view: 'tasks', issueId: null };
}

const NAV_ITEMS: ReadonlyArray<{ view: NavView; label: string }> = [
  { view: 'new-issue', label: 'Новая задача' },
  { view: 'tasks', label: 'Мои задачи' },
];

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const selectedIssueId = route.issueId;
  const view: View =
    route.view === 'task-detail' && !selectedIssueId ? 'tasks' : route.view;

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

  function renderNavItems(extra: string) {
    return NAV_ITEMS.map((item) => {
      const active = view === item.view;
      return (
        <button
          key={item.view}
          type="button"
          title={item.label}
          aria-label={item.label}
          aria-current={active ? 'page' : undefined}
          className={[
            'rounded-none border border-transparent px-3 py-2 text-sm font-medium transition-colors',
            active
              ? 'glow border-[#008F11] bg-[#008F11]/30 text-[#00FF41]'
              : 'text-[#00FF41]/60 hover:bg-[#008F11]/20 hover:text-[#00FF41]',
            extra,
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => navigate(item.view === 'tasks' ? '/tasks' : '/new')}
        >
          <span>{item.label}</span>
        </button>
      );
    });
  }

  return (
    <div className="flex h-full flex-col bg-[#0D0208] text-[#00FF41]">
      <main className="flex-1 overflow-auto py-6 px-2 pb-24 sm:px-4 md:px-6 md:pb-6">
        {view === 'new-issue' && (
          <NewIssue
            onCreated={(issue) => navigate(`/tasks/${issue.id}`)}
            onBack={() => navigate('/tasks')}
          />
        )}
        {view === 'tasks' && (
          <TasksList
            onOpenTask={openTask}
            onCreateTask={() => navigate('/new')}
            onOpenResult={openResult}
          />
        )}
        {view === 'task-detail' && (
          <TaskDetail
            issueId={selectedIssueId}
            onBack={() => navigate('/tasks')}
            autoOpenResult={route.openResult}
          />
        )}
      </main>

      <nav
        aria-label="Мобильная навигация"
        className="fixed inset-x-0 bottom-0 z-10 flex gap-1 overscroll-none border-t border-[#008F11] bg-[#003B00] px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
      >
        {renderNavItems('min-h-12 flex-1 text-center')}
      </nav>
    </div>
  );
}