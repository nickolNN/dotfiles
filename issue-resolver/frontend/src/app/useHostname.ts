import { useEffect } from 'react';
import { useUIStore } from '../stores/ui';

export function useHostname() {
  const hostname = useUIStore((state) => state.hostname);
  const setHostname = useUIStore((state) => state.setHostname);
  const loadHostname = useUIStore((state) => state.loadHostname);

  useEffect(() => {
    void loadHostname();
  }, [loadHostname]);

  useEffect(() => {
    document.title = hostname || 'Issue Resolver';
  }, [hostname]);

  return { hostname, setHostname };
}