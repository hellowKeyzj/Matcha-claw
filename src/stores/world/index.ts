import { create } from 'zustand';
import i18n from '@/i18n';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import type {
  ActionProposal, BlobRef, ChangeSet, CommandResult, ConnectionView, Definition, Failure, ImportMaterials, MaterialDraftRef, MaterialInput,
  OperationAccepted, OperationRequest, QueryPage, QueryResult, SourceVersion, TestCase, WorldCommand, WorldCommandEnvelope, WorldDescription,
  UpgradePackage, WorldHint, WorldQuery, WorldRef,
} from '@/types/world';
import {
  commandWorld, configureSource, digestBytes, digestFile, openStorage, queryWorld, sameWorld, transferStorage, WorldDeliveryUnknown, WorldRequestError,
  type SourceCredential, type StorageOpenInput, type StorageOpenResult, type StorageTransferInput, type StorageTransferResult,
} from './client';

export type MaterialImportOptions = Pick<ImportMaterials, 'scope' | 'access' | 'retention' | 'budget'>;
type EvaluationPage = Extract<QueryResult, { kind: 'evaluations' }>['result'];
type Pending = { request: WorldCommandEnvelope; privateConnection: boolean };
type ActionSubmission = { request: Extract<WorldCommand, { kind: 'action_submit' }>['request']; operation: OperationAccepted };
type UploadCommand = Extract<WorldCommand, { kind: 'import_materials' | 'install_package' | 'upgrade_package' | 'record_test_case' }>;
type UploadProgress = {
  world: WorldRef; name: string; received: number; total: number; transferId?: string; state: string;
  submission?: Pick<WorldCommandEnvelope, 'world' | 'requestId'> & { kind: UploadCommand['kind']; failure?: Failure };
};
type WorldState = {
  world: WorldRef | null;
  storageOpen: StorageOpenResult | null;
  storageOpening: boolean;
  openStorage(input?: StorageOpenInput): Promise<StorageOpenResult>;
  description: WorldDescription | null;
  definitions: Definition[];
  materials: SourceVersion[];
  materialDraft: MaterialDraftRef | null;
  reviewMaterialDraft(draft: MaterialDraftRef): void;
  connections: ConnectionView[];
  proposals: ActionProposal[];
  operations: OperationAccepted[];
  actionSubmissions: ActionSubmission[];
  trackOperation(operation: OperationAccepted): void;
  changes: ChangeSet[];
  evaluations: EvaluationPage['items'];
  objects: QueryPage | null;
  selectedType: Definition | null;
  workspaceVersion: number;
  projectionReady: boolean;
  loading: boolean;
  busy: boolean;
  error: unknown;
  notice: string | null;
  pending: Pending | null;
  pendingOperation: OperationRequest | null;
  operationBusy: boolean;
  storageTransfer: StorageTransferResult | null;
  transferBusy: boolean;
  transferStorage(input: StorageTransferInput): Promise<void>;
  upload: UploadProgress | null;
  selectWorld(world: WorldRef): Promise<boolean>;
  refresh(): Promise<boolean>;
  loadObjects(definition: Definition, cursor?: string): Promise<boolean>;
  command(command: WorldCommand): Promise<CommandResult>;
  configure(command: Extract<WorldCommand, { kind: 'configure_connection' }>, credential: SourceCredential): Promise<CommandResult>;
  retryPending(): Promise<void>;
  uploadFile(file: File, options: MaterialImportOptions): Promise<void>;
  uploadPackage(file: File, upgrade?: Pick<UpgradePackage, 'installId' | 'expectedRevision'>): Promise<CommandResult | null>;
  recordTestCase(test: Omit<TestCase, 'fixture' | 'expected'>, fixture: File, expected: File): Promise<void>;
  cancelUpload(): void;
  importSelection(source: MaterialInput, options: MaterialImportOptions): Promise<void>;
};
const page = { limit: 100, cursor: null };
let readGeneration = 0;
let objectGeneration = 0;
let knownIncarnation: WorldDescription['incarnation'] | null = null;
let stopped = false;
let retrying = false;
let pendingObserver: { resolve(value: CommandResult): void; reject(error: unknown): void } | null = null;
const clearProjection = () => ({ definitions: [], materials: [], connections: [], proposals: [], changes: [], evaluations: [], objects: null, projectionReady: false });
const clear = () => ({ ...clearProjection(), description: null, materialDraft: null, selectedType: null });
const selectionKey = 'world.last-selected';
function lastSelectedWorld(): WorldRef | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(selectionKey) ?? 'null');
    return stored && typeof stored === 'object' && 'tenantId' in stored && 'worldId' in stored
      && typeof stored.tenantId === 'string' && typeof stored.worldId === 'string'
      ? { tenantId: stored.tenantId, worldId: stored.worldId } : null;
  } catch { return null; }
}
function rememberWorld(world: WorldRef): void {
  try { localStorage.setItem(selectionKey, JSON.stringify(world)); }
  catch { /* An unavailable preference store does not invalidate the open world. */ }
}

export const useWorldStore = create<WorldState>((set, get) => {
  let opening: Promise<StorageOpenResult> | null = null;
  const selectWorld = async (world: WorldRef): Promise<boolean> => {
    readGeneration++; objectGeneration++; knownIncarnation = null;
    set(state => ({ world, ...clear(), workspaceVersion: state.workspaceVersion + 1,
      loading: false, storageTransfer: null, error: null, notice: null }));
    const loaded = await get().refresh();
    if (loaded) rememberWorld(world);
    return loaded;
  };
  const selectedWorld = (): WorldRef => {
    const world = get().world;
    if (!world) throw new Error(i18n.t('world:store.chooseWorld'));
    return world;
  };
  const send = async (command: WorldCommand, credential?: SourceCredential, observeRequest?: (request: WorldCommandEnvelope) => void): Promise<CommandResult> => {
    const request: WorldCommandEnvelope = { world: selectedWorld(), requestId: crypto.randomUUID(), command };
    observeRequest?.(request);
    try { return credential ? await configureSource(request, credential) : await commandWorld(request); }
    catch (error) {
      if (!(error instanceof WorldDeliveryUnknown)) throw error;
      set({ pending: { request, privateConnection: credential !== undefined }, notice: error.message });
      // Keep the exact request and workflow custody. Retry never creates another request identity.
      return new Promise<CommandResult>((resolve, reject) => { pendingObserver = { resolve, reject }; });
    }
  };
  const accept = async (result: CommandResult) => {
    if (result.kind === 'accepted') get().trackOperation(result.result);
    set({ notice: result.kind === 'accepted' ? i18n.t('world:store.accepted') : i18n.t('world:store.saved') });
    await get().refresh();
  };
  const submitUpload = async (command: UploadCommand): Promise<CommandResult> => {
    try {
      return await send(command, undefined, request => {
        set(state => ({ upload: { ...state.upload!, submission: { world: request.world, requestId: request.requestId, kind: command.kind } } }));
      });
    } catch (error) {
      if (error instanceof WorldRequestError) {
        set(state => ({ upload: { ...state.upload!, submission: { ...state.upload!.submission!, failure: error.failure } } }));
      }
      throw error;
    }
  };
  const uploadSealed = async (file: File): Promise<{ transferId: string; blob: BlobRef } | null> => {
    const world = selectedWorld();
    set({ upload: { world, name: file.name, received: 0, total: file.size, state: i18n.t('world:store.upload.preparing') } });
    const digest = await digestFile(file);
    if (stopped) return null;
    const begin = await send({ kind: 'begin_upload', request: { name: file.name, mediaType: file.type || 'application/octet-stream', size: String(file.size), digest } });
    if (begin.kind !== 'upload' || begin.result.state.kind !== 'receiving' || begin.result.received !== '0') throw new Error(i18n.t('world:store.upload.beginMismatch'));
    const transferId = begin.result.transferId;
    set({ upload: { world, name: file.name, transferId, received: 0, total: file.size, state: i18n.t('world:store.upload.uploading') } });
    let received = 0;
    while (received < file.size && !stopped) {
      const bytes = await file.slice(received, received + 131_072).arrayBuffer();
      const chunk = await send({ kind: 'upload_chunk', request: { transferId, offset: String(received), digest: await digestBytes(bytes), bytes: Array.from(new Uint8Array(bytes)) } });
      if (chunk.kind !== 'upload' || chunk.result.transferId !== transferId || chunk.result.state.kind !== 'receiving'
        || BigInt(chunk.result.received) !== BigInt(received + bytes.byteLength)) throw new Error(i18n.t('world:store.upload.chunkMismatch'));
      received += bytes.byteLength;
      set({ upload: { world, name: file.name, transferId, received, total: file.size, state: i18n.t('world:store.upload.uploading') } });
    }
    if (stopped) {
      const aborted = await send({ kind: 'abort_upload', request: { transferId } });
      if (aborted.kind !== 'upload' || aborted.result.transferId !== transferId || aborted.result.state.kind !== 'aborted') throw new Error(i18n.t('world:store.upload.cancelUnconfirmed'));
      set({ upload: { world, name: file.name, transferId, received, total: file.size, state: i18n.t('world:store.upload.cancelled') } });
      return null;
    }
    set({ upload: { world, name: file.name, transferId, received, total: file.size, state: i18n.t('world:store.upload.verifying') } });
    const seal = await send({ kind: 'seal_upload', request: { transferId, size: String(file.size), digest } });
    if (seal.kind !== 'upload' || seal.result.transferId !== transferId || seal.result.state.kind !== 'sealed'
      || seal.result.state.blob.digest !== digest || seal.result.state.blob.byteSize !== String(file.size)) throw new Error(i18n.t('world:store.upload.sealMismatch'));
    if (stopped) {
      set({ notice: i18n.t('world:store.upload.sealedNotSubmitted') });
      return null;
    }
    return { transferId, blob: seal.result.state.blob };
  };
  const requireWritable = () => {
    const state = get();
    if (!state.projectionReady || state.loading || state.storageOpening || state.busy || state.operationBusy || state.pending || state.pendingOperation || state.transferBusy) {
      throw new Error(i18n.t('world:store.busy'));
    }
    if (!state.world || !state.description || !sameWorld(state.description.world, state.world) || state.description.status !== 'ready') {
      throw new Error(i18n.t('world:store.chooseWorld'));
    }
  };
  const run = async (command: WorldCommand, credential?: SourceCredential): Promise<CommandResult> => {
    requireWritable();
    if (command.kind === 'action_submit') {
      const previous = get().actionSubmissions.find(item => sameWorld(item.request.world, command.request.world)
        && item.request.proposalId === command.request.proposalId && item.request.proposalDigest === command.request.proposalDigest);
      if (previous) return { kind: 'accepted', result: previous.operation };
    }
    set({ busy: true, error: null, notice: null });
    try {
      const result = await send(command, credential);
      if (command.kind === 'action_submit' && result.kind === 'accepted') {
        set(state => ({ actionSubmissions: [...state.actionSubmissions, { request: command.request, operation: result.result }] }));
      }
      await accept(result); return result;
    }
    catch (error) { set({ error }); throw error; }
    finally { set({ busy: false }); }
  };
  return {
    world: null, ...clear(), workspaceVersion: 0, loading: false, busy: false, error: null,
    storageOpen: null, storageOpening: false,
    openStorage: input => {
      if (opening) return opening;
      const state = get();
      if (state.busy || state.operationBusy || state.pending || state.pendingOperation || state.transferBusy) {
        return Promise.reject(new Error(i18n.t('world:store.switchBlocked')));
      }
      set({ storageOpening: true });
      opening = (async () => {
        try {
          const result = await openStorage(input);
          set({ storageOpen: result });
          if (result.outcome === 'opened') {
            const current = get().world;
            const saved = lastSelectedWorld();
            const worlds = result.worlds;
            const selected = worlds.find(world => current && sameWorld(world, current))
              ?? worlds.find(world => saved && sameWorld(world, saved))
              ?? (worlds.length === 1 ? worlds[0] : null);
            if (selected) {
              if (current && sameWorld(current, selected)) await get().refresh();
              else await selectWorld(selected);
            } else {
              readGeneration++; objectGeneration++; knownIncarnation = null;
              set(state => ({ world: null, ...clear(), loading: false, error: null,
                workspaceVersion: state.workspaceVersion + 1 }));
            }
          }
          return result;
        } finally {
          opening = null;
          set({ storageOpening: false });
        }
      })();
      return opening;
    },
    notice: null, pending: null, pendingOperation: null, operationBusy: false,
    storageTransfer: null, transferBusy: false, upload: null, operations: [], actionSubmissions: [],
    trackOperation: operation => set(state => ({ operations: [operation, ...state.operations.filter(item => item.operationId !== operation.operationId || !sameWorld(item.world, operation.world))] })),
    selectWorld: async world => {
      const state = get();
      if (state.storageOpening || state.busy || state.operationBusy || state.pending || state.pendingOperation || state.transferBusy) throw new Error(i18n.t('world:store.switchBlocked'));
      return selectWorld(world);
    },
    reviewMaterialDraft: draft => {
      const world = get().world;
      if (world && sameWorld(world, draft.world)) set({ materialDraft: draft });
    },
    transferStorage: async input => {
      if (get().transferBusy || (input.action !== 'status' && (get().storageOpening || get().busy || get().operationBusy || get().pendingOperation))) return;
      const world = selectedWorld();
      const previous = get().storageTransfer;
      const transferId = 'transferId' in input ? input.transferId
        : previous?.outcome === 'status' ? previous.transfer.transferId
          : previous?.outcome === 'unknown' ? previous.transferId : undefined;
      set({ transferBusy: true, error: null });
      try {
        const result = await transferStorage(input);
        if (result.outcome === 'status' && (!sameWorld(result.transfer.world, world)
          || ('transferId' in input && result.transfer.transferId !== input.transferId)
          || (input.action === 'prepare' && result.transfer.targetStorageId !== input.targetStorageId))) throw new Error(i18n.t('world:store.transferMismatch'));
        set({ storageTransfer: result });
        if (result.outcome === 'status' && (result.transfer.phase === 'activated' || result.transfer.phase === 'aborted')) await get().refresh();
      } catch {
        set({ storageTransfer: { outcome: 'unknown', reason: 'storage-unavailable', ...(transferId ? { transferId } : {}) }, notice: i18n.t('world:store.transferUnknown') });
      } finally { set({ transferBusy: false }); }
    },
    refresh: async () => {
      const world = get().world;
      if (!world) return false;
      const generation = ++readGeneration;
      objectGeneration++;
      const previous = get().description;
      // Projection freshness is not workspace identity; revoke the editing basis without unmounting its owner.
      set({ ...clearProjection(), description: previous ? { ...previous, editingContext: null } : null, loading: true, error: null });
      try {
        const description = await queryWorld(world, { kind: 'discover', request: { includeCapabilities: true } }, 'discover');
        if (!sameWorld(description.world, world)) throw new Error(i18n.t('world:store.worldMismatch'));
        if (generation !== readGeneration) return false;
        if (knownIncarnation && BigInt(description.incarnation) < BigInt(knownIncarnation)) return false;
        const changedIncarnation = knownIncarnation !== null && description.incarnation !== knownIncarnation;
        knownIncarnation = description.incarnation;
        if (changedIncarnation || description.status !== 'ready') {
          objectGeneration++;
          set(state => ({ ...clear(), description: { ...description, editingContext: null }, workspaceVersion: state.workspaceVersion + 1 }));
        } else set({ description: { ...description, editingContext: null } });
        if (description.status !== 'ready') return false;
        const queries: Array<[WorldQuery, QueryResult['kind']]> = [
          [{ kind: 'definitions', request: { kind: null, page } }, 'definitions'],
          [{ kind: 'materials', request: { page } }, 'materials'],
          [{ kind: 'connections', request: { page } }, 'connections'],
          [{ kind: 'action_proposals', request: { page } }, 'action_proposals'],
          [{ kind: 'changes', request: { page } }, 'changes'],
          [{ kind: 'evaluations', request: { page } }, 'evaluations'],
        ];
        const loaded = await Promise.all(queries.map(async ([query, kind]) => {
          try {
            const result = await queryWorld(world, query, kind);
            if (generation !== readGeneration) return false;
            switch (kind) {
              case 'definitions': set({ definitions: (result as Extract<QueryResult, { kind: 'definitions' }>['result']).items }); break;
              case 'materials': set({ materials: (result as Extract<QueryResult, { kind: 'materials' }>['result']).items }); break;
              case 'connections': set({ connections: (result as Extract<QueryResult, { kind: 'connections' }>['result']).items }); break;
              case 'action_proposals': set({ proposals: (result as Extract<QueryResult, { kind: 'action_proposals' }>['result']).items }); break;
              case 'changes': set({ changes: (result as Extract<QueryResult, { kind: 'changes' }>['result']).items }); break;
              case 'evaluations': set({ evaluations: (result as EvaluationPage).items }); break;
            }
            return true;
          } catch (error) { if (generation === readGeneration) set({ error }); return false; }
        }));
        if (generation !== readGeneration) return false;
        const complete = loaded.every(Boolean);
        const selected = get().selectedType;
        const selectedType = selected && get().definitions.find(item => sameWorld(item.reference.world, selected.reference.world)
          && item.reference.id === selected.reference.id && item.reference.revision === selected.reference.revision);
        if (selected && !selectedType) set({ selectedType: null });
        if (complete && selectedType && !await get().loadObjects(selectedType)) return false;
        if (!complete || generation !== readGeneration) return false;
        set({ description, projectionReady: true });
        return true;
      } catch (error) { if (generation === readGeneration) set({ error }); return false; }
      finally { if (generation === readGeneration) set({ loading: false }); }
    },
    loadObjects: async (definition, cursor) => {
      const world = selectedWorld();
      const generation = ++objectGeneration;
      set({ selectedType: definition, objects: null, error: null });
      const body = definition.body;
      const properties = body.kind === 'object_type' ? body.body.properties : [];
      try {
        const objects = await queryWorld(world, { kind: 'objects', request: {
          world, query: {
            root: { kind: 'objects', typeRef: definition.reference, symbol: 'item' }, parameters: [], limit: 100,
            output: properties.map(property => ({ name: property.id, expression: { kind: 'field', subject: 'item', property } })),
          }, arguments: [], readMode: { kind: 'authoritative' }, page: { limit: 100, cursor },
        } }, 'objects');
        if (generation !== objectGeneration || !get().world || !sameWorld(get().world!, world)) return false;
        set({ objects });
        return true;
      } catch (error) { if (generation === objectGeneration) set({ error }); return false; }
    },
    command: command => run(command),
    configure: (command, credential) => run(command, credential),
    retryPending: async () => {
      const pending = get().pending;
      if (!pending || !pendingObserver || retrying) return;
      const observer = pendingObserver;
      retrying = true;
      try {
        const result = pending.privateConnection ? await configureSource(pending.request) : await commandWorld(pending.request);
        pendingObserver = null;
        set({ pending: null, notice: null }); observer.resolve(result);
      } catch (error) {
        if (error instanceof WorldDeliveryUnknown) { set({ notice: error.message }); return; }
        pendingObserver = null;
        set({ pending: null, error }); observer.reject(error);
      } finally { retrying = false; }
    },
    uploadFile: async (file, options) => {
      requireWritable();
      stopped = false;
      set({ busy: true, error: null, notice: null });
      try {
        const sealed = await uploadSealed(file);
        if (!sealed) return;
        const result = await submitUpload({ kind: 'import_materials', request: { sources: [{ kind: 'sealed_upload', ...sealed, name: file.name, mediaType: file.type || 'application/octet-stream' }], ...options } });
        set(state => ({ upload: { ...state.upload!, state: i18n.t('world:store.upload.importAccepted') } }));
        await accept(result);
      } catch (error) {
        set(state => ({ error, upload: { ...state.upload!, state: i18n.t('world:store.upload.incomplete') } }));
        throw error;
      } finally { set({ busy: false }); }
    },
    uploadPackage: async (file, upgrade) => {
      requireWritable();
      if (!file.size || file.size > 1024 * 1024 * 1024) throw new Error(i18n.t('world:packages.management.fileLimit'));
      stopped = false;
      set({ busy: true, error: null, notice: null });
      try {
        const sealed = await uploadSealed(file);
        if (!sealed) return null;
        const input = { package: sealed.blob, upload: { transferId: sealed.transferId } };
        const result = await submitUpload(upgrade
          ? { kind: 'upgrade_package', request: { ...upgrade, ...input } }
          : { kind: 'install_package', request: { ...input, requestKey: crypto.randomUUID() } });
        set(state => ({ upload: { ...state.upload!, state: i18n.t(result.kind === 'accepted' ? 'world:store.accepted' : 'world:store.saved') } }));
        await accept(result);
        return result;
      } catch (error) {
        set(state => ({ error, upload: { ...state.upload!, state: i18n.t('world:store.upload.incomplete') } }));
        throw error;
      } finally { set({ busy: false }); }
    },
    recordTestCase: async (test, fixtureFile, expectedFile) => {
      requireWritable();
      if (!sameWorld(selectedWorld(), test.world) || !fixtureFile.size || !expectedFile.size) throw new Error(i18n.t('world:store.testInputInvalid'));
      stopped = false;
      set({ busy: true, error: null, notice: null });
      try {
        const fixture = await uploadSealed(fixtureFile);
        if (!fixture) return;
        const expected = await uploadSealed(expectedFile);
        if (!expected || stopped) {
          set({ notice: i18n.t('world:store.testNotRecorded') });
          return;
        }
        const result = await submitUpload({ kind: 'record_test_case', request: { test: { ...test, fixture: fixture.blob, expected: expected.blob }, fixture: { transferId: fixture.transferId }, expected: { transferId: expected.transferId } } });
        set(state => ({ upload: { ...state.upload!, state: i18n.t('world:store.upload.testAccepted') } }));
        await accept(result);
      } catch (error) {
        set({ error }); throw error;
      } finally { set({ busy: false }); }
    },
    cancelUpload: () => { stopped = true; set({ notice: i18n.t('world:store.cancelNotice') }); },
    importSelection: async (source, options) => { await run({ kind: 'import_materials', request: { sources: [source], ...options } }); },
  };
});

export function observeWorld(): () => void {
  const invalidate = () => {
    readGeneration++; objectGeneration++;
    useWorldStore.setState(state => ({ ...clear(), workspaceVersion: state.workspaceVersion + 1, loading: false }));
  };
  const hint = (value: WorldHint) => {
    const state = useWorldStore.getState();
    if (!state.world || !sameWorld(state.world, value.world)) return;
    if (knownIncarnation && BigInt(value.incarnation) < BigInt(knownIncarnation)) return;
    if (knownIncarnation && BigInt(value.incarnation) > BigInt(knownIncarnation)) invalidate();
    knownIncarnation = value.incarnation;
    void useWorldStore.getState().refresh();
  };
  const unsubscribers = [
    subscribeHostEvent<WorldHint>('world:changed', hint), subscribeHostEvent<WorldHint>('world:resync-required', hint),
    subscribeHostEvent('runtime-host:disconnected', invalidate),
    subscribeHostEvent('runtime-host:restart', () => {
      invalidate();
      void useWorldStore.getState().openStorage().catch(error => useWorldStore.setState({ error }));
    }),
    subscribeBrowserRecovery(() => { void useWorldStore.getState().refresh(); }),
  ];
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}
