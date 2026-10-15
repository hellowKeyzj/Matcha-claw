import { create } from 'zustand';
import { hostWikiCallResult, hostWikiCreateProject, hostWikiImportArchive, hostWikiOpenProject, hostWikiProjects, type HostWikiRequest } from '@/lib/host-api';
import { waitForCall } from '@/lib/call-log-await';
import { isRecord, normalizeProjects, type WikiProject } from '@/pages/Wiki/wiki-model';

type WikiProjectProjection = {
  projects: readonly WikiProject[];
  currentProject: WikiProject | null;
};

type WikiProjectsState = WikiProjectProjection & {
  loading: boolean;
  switching: boolean;
  ready: boolean;
  refresh: () => Promise<WikiProjectProjection>;
  openProject: (project: WikiProject) => Promise<void>;
  createProject: (input: HostWikiRequest) => Promise<void>;
  importArchive: (input: { archivePath: string; destination: string }) => Promise<boolean>;
};

let generation = 0;
let refreshPromise: Promise<WikiProjectProjection> | null = null;
let switchingPromise: Promise<void> | null = null;

function projectReceipt(payload: unknown): WikiProjectProjection {
  if (!isRecord(payload) || !Array.isArray(payload.projects)
    || (payload.currentProjectId !== null && typeof payload.currentProjectId !== 'string')) {
    throw new Error('Invalid Wiki project receipt');
  }
  const projects = normalizeProjects(payload);
  if (projects.length !== payload.projects.length) throw new Error('Invalid Wiki projects');
  const currentProject = projects.find((project) => project.projectId === payload.currentProjectId) ?? null;
  if (payload.currentProjectId !== null && !currentProject) throw new Error('Invalid Wiki current project receipt');
  return { projects, currentProject };
}

export const useWikiProjectsStore = create<WikiProjectsState>((set, get) => {
  const mutateProject = (task: () => Promise<unknown>, expectedProjectId?: string): Promise<void> => {
    if (get().switching) return Promise.reject(new Error('Wiki project switch is in progress'));
    generation++;
    refreshPromise = null;
    set({ switching: true, loading: false });
    const mutation = Promise.resolve().then(task).then((payload) => {
      const projection = projectReceipt(payload);
      if (expectedProjectId && projection.currentProject?.projectId !== expectedProjectId) {
        throw new Error('Wiki project switch was not confirmed');
      }
      set({ ...projection, ready: true });
    }).finally(() => {
      generation++;
      refreshPromise = null;
      switchingPromise = null;
      set({ switching: false, loading: false });
    });
    switchingPromise = mutation;
    return mutation;
  };

  return {
    projects: [],
    currentProject: null,
    loading: false,
    switching: false,
    ready: false,
    refresh: () => {
      if (get().switching) return Promise.resolve(get());
      if (refreshPromise) return refreshPromise;
      const requestGeneration = generation;
      set({ loading: true });
      const task = hostWikiProjects().then((payload) => {
        if (requestGeneration !== generation) return get();
        const projection = projectReceipt(payload);
        set({ ...projection, ready: true });
        return projection;
      }).finally(() => {
        if (refreshPromise === task) {
          refreshPromise = null;
          set({ loading: false });
        }
      });
      refreshPromise = task;
      return task;
    },
    openProject: (project) => mutateProject(
      () => hostWikiOpenProject({ path: project.rootPath, name: project.title }),
      project.projectId,
    ),
    createProject: (input) => mutateProject(() => hostWikiCreateProject(input)),
    importArchive: async (input) => {
      let refreshed: boolean;
      try {
        const receipt = await hostWikiImportArchive(input);
        const call = await waitForCall(receipt, 'wiki', { timeoutMs: null });
        if (call.callId !== receipt.callId || call.command !== 'project.import-archive'
          || call.detail.operation !== 'project.import-archive' || call.status === 'unknown') {
          throw new Error('Wiki archive import result is unconfirmed');
        }
        if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') throw new Error('Wiki archive import failed');
        const result = await hostWikiCallResult({ callId: receipt.callId });
        if (result.callId !== receipt.callId || result.operation !== 'project.import-archive'
          || !projectReceipt(result.result).currentProject) throw new Error('Wiki archive import result is unconfirmed');
      } finally {
        // Import changes native current even after its panel stops observing.
        while (switchingPromise) await switchingPromise.catch(() => {});
        generation++;
        refreshPromise = null;
        refreshed = await get().refresh().then(() => true, () => false);
      }
      return refreshed;
    },
  };
});
