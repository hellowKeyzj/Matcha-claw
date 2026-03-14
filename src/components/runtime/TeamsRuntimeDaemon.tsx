import { useEffect } from 'react';
import { teamsBackgroundOrchestrator } from '@/features/teams/runtime/orchestrator';

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

