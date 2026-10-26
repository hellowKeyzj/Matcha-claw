import { ListTodo } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const TasksPage = lazyWithPreload(() => import('./pages/Tasks'));

async function prefetchTasks(): Promise<void> {
  const [
    { useChatStore },
    { readSessionsFromState },
    { isRuntimeEndpointReady, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore },
    { runtimeEndpointsEqual },
    { useTaskCenterStore },
  ] = await Promise.all([
    import('@/plugins/chat/store'),
    import('@/plugins/chat/store/session-helpers'),
    import('@/stores/runtime-endpoints'),
    import('@/types/desktop/runtime-address'),
    import('./stores/task-center-store'),
  ]);
  const chatState = useChatStore.getState();
  const currentSession = readSessionsFromState(chatState).find((session) => session.key === chatState.currentSessionKey);
  const runtime = currentSession && useRuntimeEndpointsStore.getState().endpoints.find(
    (entry) => runtimeEndpointsEqual(entry.endpointRef, currentSession.sessionIdentity.endpoint));
  if (!currentSession || !runtime || !isRuntimeEndpointReady(runtime) || !supportsRuntimeEndpointCapabilityFamily(runtime, 'task')) {
    return;
  }
  const taskSession = {
    recordKey: currentSession.key,
    sessionIdentity: currentSession.sessionIdentity,
  };
  const taskCenter = useTaskCenterStore.getState();
  if (!taskCenter.initialized) {
    void taskCenter.init(taskSession);
  }
  await taskCenter.refreshTasks({
    sessionKey: taskSession.recordKey,
    sessionIdentity: taskSession.sessionIdentity,
    silent: true,
  });
}

export const tasksPlugin = definePlugin({
  id: 'tasks',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, {
      id: 'tasks',
      path: '/tasks',
      component: TasksPage,
      preload: TasksPage.preload,
    }),
    contribute(applicationPages, {
      id: 'cron',
      path: '/cron',
      redirectTo: '/tasks?tab=scheduled',
      preload: TasksPage.preload,
    }),
    contribute(applicationNavigation, {
      id: 'tasks',
      to: '/tasks',
      label: 'common:sidebar.tasks',
      icon: ListTodo,
      order: 10,
      prefetch: prefetchTasks,
    }),
  ],
});
