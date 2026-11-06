import { useState } from 'react';
import DesktopHeader from './app/DesktopHeader';
import MobileNav from './app/MobileNav';
import MobileTopbar from './app/MobileTopbar';
import {
  TAB_PATHS,
  activeTabOf,
  primaryLabelOf,
  type Tab,
} from './app/routing';
import { useAppRoute } from './app/useAppRoute';
import { useContainerStats } from './app/useContainerStats';
import { useHostname } from './app/useHostname';
import NewIssue from './views/NewIssue';
import Repositories from './views/Repositories';
import Settings from './views/Settings';
import Tags from './views/Tags';
import TasksList from './views/TasksList';
import TaskDetail from './views/TaskDetail';

export default function App() {
  const { route, navigate, openTask, openResult } = useAppRoute();
  const { hostname, setHostname } = useHostname();
  const containerStats = useContainerStats();
  const [repoCreateSignal, setRepoCreateSignal] = useState(0);
  const [tagCreateSignal, setTagCreateSignal] = useState(0);

  const selectedIssueId = route.issueId;
  const view =
    route.view === 'task-detail' && !selectedIssueId ? 'tasks' : route.view;
  const activeTab = activeTabOf(view);
  const primaryLabel = primaryLabelOf(activeTab);

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
      <MobileTopbar
        stats={containerStats}
        primaryLabel={primaryLabel}
        onPrimary={handlePrimaryAction}
      />

      <DesktopHeader
        activeTab={activeTab}
        stats={containerStats}
        primaryLabel={primaryLabel}
        onTabClick={handleTabClick}
        onNavigateSettings={() => navigate('/settings')}
        onPrimary={handlePrimaryAction}
      />

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
        {view === 'settings' && (
          <Settings hostname={hostname} onHostnameChange={setHostname} />
        )}
        {view === 'tasks' && (
          <TasksList onOpenTask={openTask} onOpenResult={openResult} />
        )}
        {view === 'task-detail' && (
          <TaskDetail
            issueId={selectedIssueId}
            autoOpenResult={route.openResult}
          />
        )}
      </main>

      <MobileNav activeTab={activeTab} onTabClick={handleTabClick} />
    </div>
  );
}