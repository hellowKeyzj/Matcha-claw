import { useEffect } from 'react';
import { teamsBackgroundOrchestrator } from '@/lib/team/background-orchestrator';

export function TeamsRuntimeDaemon() {
  useEffect(() => {
    teamsBackgroundOrchestrator.start();
    return () => {
      teamsBackgroundOrchestrator.stop();
    };
  }, []);

  return null;
}

export default TeamsRuntimeDaemon;

