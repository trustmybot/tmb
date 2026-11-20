import { useEffect, useState } from 'react';
import { CodeIcon, HomeIcon, IssueOpenedIcon, LogIcon, PlayIcon, TasklistIcon } from '@primer/octicons-react';
import { useLiveRefresh } from './api.ts';
import { DETAIL_PAGE, HELP, helpKey, type HelpKey } from './shared/help-copy.ts';
import { AppHeader } from './ui/AppHeader.tsx';
import { HelpToggletip } from './ui/HelpToggletip.tsx';
import { UnderlineNav, type NavTab } from './ui/UnderlineNav.tsx';
import { AuditView } from './views/AuditView.tsx';
import { CodeView } from './views/CodeView.tsx';
import { IssuesView } from './views/IssuesView.tsx';
import { IssueView } from './views/IssueView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { RunsView } from './views/RunsView.tsx';
import { TasksView } from './views/TasksView.tsx';
import { TaskView } from './views/tasks/TaskView.tsx';

export const TABS: readonly NavTab[] = [
  ['overview', 'Overview', HomeIcon],
  ['issues', 'Issues', IssueOpenedIcon],
  ['tasks', 'Tasks', TasklistIcon],
  ['runs', 'Runs & Gates', PlayIcon],
  ['audit', 'Audit', LogIcon],
  ['code', 'Code', CodeIcon],
];

const pageName = (key: HelpKey) => (key === 'issue' || key === 'task' ? DETAIL_PAGE[key] : TABS.find(([k]) => k === key)![1]);

/** A hash segment decoded, or left as it is when it is not valid percent-encoding. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function useHashRoute(): string[] {
  const read = () => {
    return window.location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean).map(decodeSegment);
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  useLiveRefresh();
  const [tab = 'overview', id] = useHashRoute();
  const help = helpKey(tab, id);
  return (
    <>
      <AppHeader />
      <UnderlineNav tabs={TABS} active={tab} />
      <main className="mx-auto w-full max-w-[120rem] space-y-4 px-4 py-4 sm:px-6 2xl:px-10">
        <div className="flex justify-end">
          <HelpToggletip key={help} page={pageName(help)} help={HELP[help]} />
        </div>
        {tab === 'issues' && id ? (
          <IssueView id={id} />
        ) : tab === 'tasks' && id ? (
          <TaskView id={id} />
        ) : (
          <TabView tab={tab} />
        )}
      </main>
    </>
  );
}

function TabView({ tab }: { tab: string }) {
  switch (tab) {
    case 'issues': return <IssuesView />;
    case 'tasks': return <TasksView />;
    case 'runs': return <RunsView />;
    case 'audit': return <AuditView />;
    case 'code': return <CodeView />;
    default: return <OverviewView />;
  }
}
