import { useEffect, useState } from 'react';
import { parsePath, type Route } from './routing';

export function useAppRoute() {
  const [route, setRoute] = useState<Route>(() => parsePath());

  useEffect(() => {
    const onPopState = () => setRoute(parsePath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(path: string) {
    const target = path.startsWith('/') ? path : `/${path}`;
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
    }
    setRoute(parsePath(target));
  }

  return {
    route,
    navigate,
    openTask: (issueId: string) => navigate(`/tasks/${issueId}`),
    openResult: (issueId: string) => navigate(`/tasks/${issueId}/result`),
  };
}