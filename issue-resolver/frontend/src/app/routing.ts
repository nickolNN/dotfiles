type View =
  | 'new-issue'
  | 'tasks'
  | 'task-detail'
  | 'repositories'
  | 'tags'
  | 'settings';

export type Tab = 'tasks' | 'repositories' | 'tags' | 'settings';

export interface Route {
  view: View;
  issueId: string | null;
  openResult?: boolean;
}

export function parsePath(path: string = window.location.pathname): Route {
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
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
  return { view: 'tasks', issueId: null };
}

export const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'tasks', label: 'Задачи' },
  { tab: 'repositories', label: 'Репозитории' },
  { tab: 'tags', label: 'Теги' },
];

export const TAB_PATHS: Record<Exclude<Tab, 'settings'>, string> = {
  tasks: '/tasks',
  repositories: '/repositories',
  tags: '/tags',
};

export function activeTabOf(view: View): Tab {
  if (view === 'repositories') return 'repositories';
  if (view === 'tags') return 'tags';
  if (view === 'settings') return 'settings';
  return 'tasks';
}

export function primaryLabelOf(activeTab: Tab): string {
  if (activeTab === 'repositories') return 'Добавить репозиторий';
  if (activeTab === 'tags') return 'Создать тег';
  return 'Создать задачу';
}