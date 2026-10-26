const projectId = 'wiki-design-library';
const world = { tenantId: 'design-studio', worldId: 'research-workspace' };
const now = '2026-10-22T09:30:00.000Z';
const time = Date.parse(now);
const modelRef = 'demo-openai/gpt-5.5';
const projects = [
  { projectId, title: '产品研究资料库', rootPath: 'C:/DesignExport/knowledge/product-research', isCurrent: true, openedAtMs: time },
  { projectId: 'wiki-design-team', title: '团队协作手册', rootPath: 'C:/DesignExport/knowledge/team-handbook', isCurrent: false, openedAtMs: time - 86400000 },
];
const templates = [
  { id: 'research', name: '研究', description: '围绕主题整理来源、概念与研究结论。', icon: 'FlaskConical' },
  { id: 'reading', name: '阅读', description: '连接阅读笔记、引用与书目。', icon: 'BookOpen' },
  { id: 'personal', name: '个人', description: '沉淀日常知识与个人经验。', icon: 'User' },
  { id: 'business', name: '业务', description: '整理产品、业务流程与团队共识。', icon: 'Briefcase' },
  { id: 'general', name: '通用', description: '从空白知识库开始。', icon: 'Folder' },
];
const pagePath = 'wiki/product-research.md';
const markdown = '# 产品研究\n\n> 本资料库中的内容全部为离线设计展示的合成样例。\n\n## 研究目标\n\n把用户访谈、产品假设和验证结果连接起来，形成可追溯的知识网络。\n\n## 关键结论\n\n- **资料有出处**：每个结论都保留原始来源。\n- **知识可连接**：通过 [[用户旅程]] 与 [[协作原则]] 发现跨主题联系。\n- **变更可审阅**：冲突与重复内容进入 Review 队列。\n\n## 下一步\n\n| 主题 | 状态 | 负责人 |\n| --- | --- | --- |\n| 用户旅程梳理 | 已完成 | 林舟 |\n| 原型验证 | 进行中 | 陈雨 |\n| 团队共识沉淀 | 待审阅 | 许宁 |\n\n参见 [[待补充的研究方法]]。\n';
const pages = [
  { path: pagePath, title: '产品研究', type: 'overview', tags: ['研究', '产品'], sources: ['research-notes.md'], origin: 'human' },
  { path: 'wiki/user-journey.md', title: '用户旅程', type: 'concept', tags: ['体验', '研究'], sources: ['interview-summary.md'], origin: 'extraction' },
  { path: 'wiki/collaboration.md', title: '协作原则', type: 'concept', tags: ['协作'], sources: ['research-notes.md'], origin: 'human' },
  { path: 'wiki/team.md', title: '研究小组', type: 'entity', tags: ['团队'], sources: [], origin: 'human' },
];
const file = (path, label, isDirectory = false, size = 1248) => ({ path, label, isDirectory, size: isDirectory ? 0 : size, modifiedAtMs: time });
const files = [file('wiki', 'wiki', true), file('raw', 'raw', true), ...pages.map(page => file(page.path, page.path.split('/').at(-1))), file('raw/sources', 'sources', true), file('raw/sources/research-notes.md', 'research-notes.md'), file('raw/sources/interview-summary.md', 'interview-summary.md', false, 2860)];
const sourceWatch = { enabled: true, autoIngest: false, outputLanguage: 'zh', generationModelRef: modelRef, captionModelRef: modelRef, captionEnabled: true, captionConcurrency: 4, mineruEnabled: false, mineruBackend: 'cloud', mineruTokenConfigured: false, mineruModelVersion: 'vlm', mineruLocalEndpoint: 'http://127.0.0.1:8000', mineruLocalTokenConfigured: false, mineruLocalBackend: 'hybrid-engine', mineruLocalEffort: 'medium', mineruLocalParseMethod: 'auto', mineruLocalLanguage: 'ch', mineruLocalFormulaEnabled: true, mineruLocalTableEnabled: true, mineruLocalImageAnalysis: true, mineruLocalServerUrl: '' };
const embedding = { enabled: true, source: 'local-minilm', endpoint: '', model: '', outputDimensionality: null, extraHeaders: {}, maxChunkChars: 1800, overlapChunkChars: 180, batchSize: 16, concurrency: 2, apiKeyConfigured: false };
const graph = { nodes: pages.map(page => ({ id: page.path, label: page.title, kind: page.type, relativePath: page.path })), edges: [{ source: pagePath, target: pages[1].path, label: '研究方法' }, { source: pagePath, target: pages[2].path, label: '协作约定' }, { source: pages[3].path, target: pages[2].path, label: '实践' }] };
const reviews = [{ id: 'review-design-1', type: 'contradiction', title: '研究周期存在不同表述', description: '两份来源分别提到双周与月度复盘，请确认当前团队约定。', sourcePath: 'raw/sources/research-notes.md', affectedPages: [pagePath, pages[2].path], options: [{ label: '保留双周复盘', action: 'fortnightly' }, { label: '采用月度复盘', action: 'monthly' }], resolved: false, resolvedAction: null, createdAt: time }, { id: 'review-design-2', type: 'missing-page', title: '研究方法缺少独立页面', description: '现有页面多次引用研究方法，但尚未形成说明。', sourcePath: null, affectedPages: [pagePath], options: [{ label: 'Create Page', action: 'Create Page' }], resolved: false, resolvedAction: null, createdAt: time - 3600000 }, { id: 'review-design-3', type: 'suggestion', title: '统一用户旅程术语', description: '已将触点名称与研究词汇表对齐。', sourcePath: null, affectedPages: [pages[1].path], options: [], resolved: true, resolvedAction: 'accepted', createdAt: time - 86400000 }];
const lintItems = [{ id: 'lint-design-1', type: 'broken-link', severity: 'warning', page: pagePath, detail: '研究方法尚未创建，可补充页面或调整链接。', affectedPages: [pagePath], brokenTarget: '待补充的研究方法', suggestedTarget: null, suggestedSource: null, createdAt: time }, { id: 'lint-design-2', type: 'orphan', severity: 'info', page: pages[3].path, detail: '研究小组尚未被其他知识页面引用。', affectedPages: [pages[3].path], brokenTarget: null, suggestedTarget: null, suggestedSource: null, createdAt: time }];
const definitionRef = (id) => ({ id, revision: '1', world });
const definition = (id, kind, body, dependencies = []) => ({ reference: definitionRef(id), body: { kind, body }, contentDigest: `sha256:design-${id}`, dependencies, evidence: [], lifecycle: { kind: 'available' }, scope: 'research', validTime: { from: now } });
const definitions = [
  definition('research-project', 'object_type', { name: '研究项目', interfaces: [], properties: [definitionRef('project-name'), definitionRef('project-stage')], sourceBindings: [] }),
  definition('project-name', 'property', { name: '项目名称', accessLabels: ['team'], cardinality: { minimum: 1, maximum: 1 }, domain: ['research-project'], nullable: false, valueType: { kind: 'text', maxLength: 160 } }),
  definition('project-stage', 'property', { name: '研究阶段', accessLabels: ['team'], cardinality: { minimum: 1, maximum: 1 }, domain: ['research-project'], nullable: false, valueType: { kind: 'text', maxLength: 80 } }),
  definition('researcher', 'object_type', { name: '研究成员', interfaces: [], properties: [definitionRef('researcher-name')], sourceBindings: [] }),
  definition('researcher-name', 'property', { name: '成员姓名', accessLabels: ['team'], cardinality: { minimum: 1, maximum: 1 }, domain: ['researcher'], nullable: false, valueType: { kind: 'text', maxLength: 80 } }),
  definition('project-membership', 'relation_type', { name: '项目协作', properties: [], roles: [{ id: 'project', name: '研究项目', targetType: definitionRef('research-project'), cardinality: { minimum: 1, maximum: 1 } }, { id: 'member', name: '研究成员', targetType: definitionRef('researcher'), cardinality: { minimum: 1 } }] }),
];
const budget = { maxBytes: '16777216', maxInputTokens: '24000', maxOutputTokens: '6000', maxModelCalls: '8', maxRows: '1000', maxSourceReads: '20', maxSteps: '40', maxWallTime: '120000' };
const trueExpression = { kind: 'literal', value: { kind: 'boolean', value: true } };
const sourceRead = { id: 'source.read', version: '1.0.0', schemaDigest: 'sha256:4fcde8fff0400d0edfd71054d0837a26c023da0bd7709291a959ff0b73a6e0cc' };
const packages = [
  ['postgres', 'PostgreSQL 业务源', 'native', { kind: 'native', registration: 'source.postgres.v1', hostBuild: 'sha256:design-host' }],
  ['http-json', 'HTTP JSON 业务源', 'native', { kind: 'native', registration: 'source.http-json.v1', hostBuild: 'sha256:design-host' }],
  ['workspace-reader', '研究资料读取器', 'wasm_component', { kind: 'wasm', world: 'design:source/read', interface: 'source-read' }],
].map(([id, name, runtime, entrypoint]) => ({
  world, installId: `install-design-${id}`, installedAt: now, revision: '1', packageDigest: `sha256:design-package-${id}`, transportDigest: `sha256:design-transport-${id}`,
  trust: { decidedAt: now, packageDigest: `sha256:design-package-${id}`, policyRevision: '1', publisher: 'design-studio', signatureVerified: true },
  lock: { digest: `sha256:design-lock-${id}`, artifacts: [{ artifactId: id, digest: `sha256:design-artifact-${id}`, packageDigest: `sha256:design-package-${id}`, target: 'any' }], contracts: [sourceRead], packages: [{ identity: { id: name, publisher: 'design-studio', version: '1.2.0' }, packageDigest: `sha256:design-package-${id}`, transportDigest: `sha256:design-transport-${id}` }] },
  manifest: { format: 'world-package-v1', identity: { id: name, publisher: 'design-studio', version: '1.2.0' }, artifacts: [{ id, runtime, entrypoint, kind: 'implementation', digest: `sha256:design-artifact-${id}`, target: 'any', features: [], abi: { closureDigest: `sha256:design-abi-${id}`, requiredFeatures: [], version: '1.0.0', witFiles: [], world: 'design:source/read' } }],
    provides: [{ artifactId: id, providerId: `design.source.${id}`, slot: 'connector', trust: runtime === 'native' ? 'trusted_native' : 'ordinary_guest', contracts: [sourceRead] }],
    config: { fields: [], revision: '1' }, contracts: [], contributions: [], dependencies: [], files: [], migrations: [], ownedKinds: [], requestedAccess: [{ kind: 'source_read', sourceId: `source-design-${id}` }], requires: [], state: [], limits: { budget, callTimeout: '30000', maximumConcurrentCalls: 2, maximumFrameBytes: '1048576', maximumInstances: 2, memoryBytes: '67108864' } },
}));
const activationLock = { id: 'design-binding-v1', digest: 'sha256:design-binding', world, nodes: packages.slice(0, 2).map(record => ({ id: `node-${record.manifest.artifacts[0].id}`, bindingId: `binding-${record.manifest.artifacts[0].id}`, providerId: record.manifest.provides[0].providerId, slot: 'connector', required: true, trust: 'trusted_native', ports: [], implementation: { artifactDigest: record.manifest.artifacts[0].digest, artifactId: record.manifest.artifacts[0].id, configDigest: 'sha256:design-config', contracts: [sourceRead], dependencyLock: record.lock.digest, entrypoint: record.manifest.artifacts[0].entrypoint, installId: record.installId, packageDigest: record.packageDigest } })), edges: [], compositions: [], roots: ['node-postgres', 'node-http-json'], trustedRoots: ['node-postgres', 'node-http-json'] };
definitions.push(definition('publish-research-summary', 'action_contract', { name: '发布研究摘要', approval: 'human', budget, effects: ['external_write'], expectedEffect: trueExpression, idempotency: 'source_key', parameters: [{ id: '摘要标题', nullable: false, optional: false, valueType: { kind: 'text', maxLength: 160 } }, { id: '通知团队', nullable: false, optional: false, valueType: { kind: 'boolean' } }], policies: [], preconditions: [trueExpression], reads: [definitionRef('research-project')], resultType: { kind: 'text', maxLength: 160 }, risk: 'reversible', sourceOperation: { binding: definitionRef('research-source'), mutation: { kind: 'insert', values: [{ field: 'title', expression: { kind: 'parameter', id: '摘要标题' } }] }, resource: 'summaries' }, targets: [], verifier: { expected: trueExpression, maximumAttempts: 3, query: { root: { kind: 'objects', typeRef: definitionRef('research-project'), symbol: 'item' }, parameters: [], output: [], limit: 20 }, requireAuthoritative: true }, writes: [definitionRef('research-project')] }));
const releaseHead = { channel: 'main', generation: '3', revision: '3', releaseId: 'release-design-3', world };
const description = { world, status: 'ready', revision: '12', incarnation: '1', activeRelease: releaseHead.releaseId, activeReleaseHead: releaseHead, operations: ['query', 'materials', 'changes'], readModes: ['authoritative', 'projected'], materialScopes: [{ scope: 'research', access: [{ policyId: 'team-access', revision: '1', labels: ['team'] }], retention: [{ policyId: 'research-retention', revision: '1' }] }], editingContext: { world, baseRelease: releaseHead.releaseId, configDigest: 'sha256:design-config', activationLock, definitions, externalContracts: [], scopes: [{ id: 'research', world, predicate: trueExpression }], targets: ['query_plan', 'validator', 'tool_catalog'] } };
const releases = [{ id: releaseHead.releaseId, activationLockId: activationLock.id, artifactId: 'artifact-design-3', publishedAt: now, previous: 'release-design-2' }, { id: 'release-design-2', activationLockId: 'design-binding-v1', artifactId: 'artifact-design-2', publishedAt: '2026-10-15T08:00:00.000Z', previous: 'release-design-1' }];
const changes = [{ world, id: 'change-design-annotation', revision: '2', baseRelease: releaseHead.releaseId, status: 'proposed', rationale: '统一项目名称和研究阶段的展示约定', cases: [], evidence: [], operations: [{ kind: 'enrich_annotation', target: definitionRef('research-project'), annotation: { label: '研究项目', description: '从研究立项到验证结论的可追溯业务对象。', aliases: ['产品研究项目'] } }] }];
const materialDraft = { world, runId: 'run-design-material', stepId: 'extract-design', revision: '1' };
const materials = [{ reference: { world, sourceId: 'research-notes', versionId: 'version-design-1' }, mediaType: 'text/markdown', originFamily: 'wiki', capturedAt: now, access: description.materialScopes[0].access[0], retention: description.materialScopes[0].retention[0], blob: { digest: 'sha256:design-research-notes', byteSize: '1248' }, lineage: [{ kind: 'wiki_page', pageId: pagePath, projectId, sourceVersions: [], version: 'history-design-1' }] }];
const readReceipt = { id: 'read-design-1', world, activationLockId: activationLock.id, actualDependencies: [], basis: [], consistency: 'per_source', coverage: { complete: true, gapSources: [], missingFields: [], missingSources: [], scopeDigest: 'sha256:design-scope' }, decisionId: 'decision-design-1', dirty: [], evaluatedScopeDigest: 'sha256:design-scope', freshness: [], grantEpoch: '1', policyEpoch: '1', observedAt: now, queryDigest: 'sha256:design-query', releaseId: releaseHead.releaseId, requestedMode: { kind: 'authoritative' } };
const objects = { objects: ['用户旅程研究', '团队知识协作', '原型可用性验证'].map((name, index) => ({ object: { world, id: `project-design-${index + 1}`, typeId: 'research-project' }, receiptId: readReceipt.id, fields: [{ property: definitionRef('project-name'), cell: { kind: 'known', value: { kind: 'text', value: name } }, dirty: { kind: 'clean' }, evidence: [] }, { property: definitionRef('project-stage'), cell: { kind: 'known', value: { kind: 'text', value: ['访谈完成', '资料整理', '验证进行中'][index] } }, dirty: { kind: 'clean' }, evidence: [] }] })), relations: [], rows: { items: [], nextCursor: null }, receipt: readReceipt };
const accepted = { world, incarnation: '1', operationId: 'operation-design-materials', revision: '1' };
const operationReceipt = { accepted, phase: 'completed', cancellation: 'not_requested', disclosure: { kind: 'full' }, effects: [], progress: { completed: '3', total: '3', stage: 'commit', runId: materialDraft.runId, stepId: materialDraft.stepId }, result: { kind: 'materials', result: { candidates: ['candidate-design-1'], drafts: [materialDraft], parseArtifacts: ['parse-design-1'], sourceVersions: materials.map(item => item.reference) } }, updatedAt: now };
const questionTasks = new Map();

export function knowledgeFixture(path, body = {}, context = {}) {
  body ??= {};
  const url = new URL(context.url || path, 'http://design.local');
  const pathname = path.split('?')[0];
  const empty = /-empty$/.test(context.scenarioId || '');
  const requestedProjectId = body?.projectId || url.searchParams.get('projectId') || projectId;
  if (pathname.startsWith('/api/wiki/')) {
    const projection = { projects: empty && context.scenarioId === 'wiki-library-empty' ? [] : projects, currentProjectId: empty && context.scenarioId === 'wiki-library-empty' ? null : projectId };
    switch (pathname.slice('/api/wiki/'.length)) {
      case 'projects': case 'project/open': case 'project/create': return projection;
      case 'project/current': return projects[0];
      case 'status': return { stateRoot: 'C:/DesignExport/knowledge', currentProject: projection.currentProjectId ? projects[0] : null, projectCount: projection.projects.length, pendingChangeCount: reviews.filter(item => !item.resolved).length };
      case 'project-templates': return { templates };
      case 'navigation': return { projectId: requestedProjectId, pages: empty ? [] : pages };
      case 'files': {
        const directory = url.searchParams.get('directory') || body.directory || '';
        return { entries: empty ? [] : files.filter(item => item.path.slice(0, Math.max(0, item.path.lastIndexOf('/'))) === directory) };
      }
      case 'source-files': return { entries: empty ? [] : files.filter(item => item.path.startsWith('raw/sources/') && !item.isDirectory) };
      case 'read-file': case 'read-source-preview': {
        const path = body.path || body.relativePath || pagePath;
        return { path, relativePath: path, content: path === pagePath ? markdown : `# ${pages.find(item => item.path === path)?.title || '访谈与研究记录'}\n\n这是一份用于离线页面展示的合成资料。\n\n## 观察\n\n资料整理需要保留来源、记录上下文，并连接到 [[产品研究]]。\n\n- 清晰的阶段与负责人\n- 可追溯的研究结论\n- 持续更新的协作约定\n` };
      }
      case 'source-watch-config': return { projectId: requestedProjectId, config: { ...sourceWatch, ...(body.config || {}) } };
      case 'search-config': return { projectId: requestedProjectId, config: { embedding: { ...embedding, ...(context.scenarioId === 'wiki-sources-embedding-remote' ? { source: 'remote', endpoint: 'https://embedding.example.invalid/v1', model: 'design-embedding', apiKeyConfigured: false } : {}), ...(body.embedding || body.config?.embedding || {}) } } };
      case 'source-tasks': return { tasks: empty ? [] : [{ id: 'source-task-design-1', sourcePath: 'raw/sources/research-notes.md', kind: 'ingest', status: 'done', updatedAtMs: time, retryCount: 0, error: null, stage: 'completed', progress: 100, completed: 4, total: 4, stageStartedAtMs: time - 60000, cancelRequestedAtMs: null }, { id: 'source-task-design-2', sourcePath: 'raw/sources/interview-summary.md', kind: 'ingest', status: 'failed', updatedAtMs: time - 120000, retryCount: 1, error: '合成示例：来源解析需重新确认。', stage: 'parse', progress: 25, completed: 1, total: 4, stageStartedAtMs: time - 180000, cancelRequestedAtMs: null }] };
      case 'reviews': return { items: empty ? [] : reviews };
      case 'search': return { query: body.query || url.searchParams.get('query') || '研究', mode: 'hybrid', tokenHits: 3, vectorHits: 2, graphHits: 1, hits: empty ? [] : pages.slice(0, 3).map((page, index) => ({ relativePath: page.path, title: page.title, score: 0.96 - index * 0.12, snippets: ['将用户访谈与产品假设连接起来，保留研究结论的来源。'], titleMatch: index === 0, vectorScore: 0.91 - index * 0.1, images: [], content: markdown, graphRelatedTo: index ? ['产品研究'] : [] })) };
      case 'retrieve-context': return { query: body.query || '研究', mode: 'hybrid', tokenHits: 1, vectorHits: 1, graphHits: 1, hits: empty ? [] : [{ relativePath: pagePath, title: '产品研究', score: 0.94, snippets: ['每个研究结论都应关联原始资料，并与用户旅程和协作原则互相连接。'], titleMatch: true, vectorScore: 0.91, graphRelatedTo: ['用户旅程', '协作原则'], images: [], content: markdown }] };
      case 'graph': return empty ? { nodes: [], edges: [] } : graph;
      case 'graph/insights': return { projectId: requestedProjectId, surprisingConnections: [{ key: 'connection-design-1', sourceId: pages[1].path, targetId: pages[2].path, score: 0.82, reasons: ['共同引用产品研究', '主题跨越体验与协作'] }], knowledgeGaps: [{ key: 'gap-design-1', type: 'isolated-node', title: '研究小组缺少知识连接', description: '成员职责尚未与研究流程连接。', nodeIds: [pages[3].path], suggestion: '补充成员与研究阶段之间的关系。' }], dismissedKeys: [] };
      case 'lint/config': return { ignoreOrphan: false, ignoreNoOutlinks: false, ignorePages: ['wiki/archive/*'], ...Object.fromEntries(Object.entries(body).filter(([key]) => ['ignoreOrphan', 'ignoreNoOutlinks', 'ignorePages'].includes(key))) };
      case 'lint/state': return { projectId: requestedProjectId, taskId: 'lint-design', phase: 'done', completed: 4, total: 4, items: empty ? [] : lintItems, error: null };
      case 'history/list': {
        const path = body.path || body.relativePath || url.searchParams.get('path') || url.searchParams.get('relativePath') || pagePath;
        return { projectId: requestedProjectId, path, entries: [{ id: 'history-design-1', path, timestamp: time - 86400000, author: '林舟', tool: 'wiki.editor', content: markdown.replace('## 下一步', '## 待办计划') }, { id: 'history-design-2', path, timestamp: time - 172800000, author: '研究助手', tool: 'wiki.ingest', content: '# 产品研究\n\n整理原始来源并形成第一版研究摘要。\n' }] };
      }
      case 'history/config': return { enabled: true, maxVersionsPerFile: 10, ...Object.fromEntries(Object.entries(body).filter(([key]) => ['enabled', 'maxVersionsPerFile'].includes(key))) };
      case 'history/stats': return { files: 4, entries: 18, bytes: 46280 };
      case 'page-links': return { projectId: requestedProjectId, outgoing: [{ title: '用户旅程', path: pages[1].path, snippet: '从触点到关键研究问题。' }, { title: '协作原则', path: pages[2].path }], backlinks: [{ title: '研究小组', path: pages[3].path, snippet: '负责产品研究与结论复盘。' }], missing: [{ title: '待补充的研究方法', snippet: '补齐访谈、观察与验证方法。' }] };
      case 'dedup/state': return { projectId: requestedProjectId, tasks: empty ? [] : [{ id: 'dedup-design-1', projectId: requestedProjectId, group: { slugs: ['wiki/user-journey.md', 'wiki/user-experience.md'], reason: '两个页面都描述用户触点与体验路径。', confidence: 'high' }, canonicalSlug: 'wiki/user-journey.md', status: 'pending', addedAt: time, error: null, retryCount: 0, paused: true }] };
      case 'embedding/reindex': return { projectId: requestedProjectId, taskId: null, status: 'done', phase: null, done: 4, total: 4, count: 12, message: null };
      case 'qa/ask': {
        const task = { id: body.taskId, projectId: requestedProjectId, question: body.question, modelRef: body.modelRef, status: 'done', answer: '## 研究资料如何形成知识？\n\n先保留原始访谈与研究记录，再把结论组织成可互相引用的知识页面。\n\n1. 以**产品研究**作为主题入口。\n2. 将观察归入**用户旅程**。\n3. 在**协作原则**中记录团队决策。\n\n所有内容均为离线合成示例。', references: [{ title: '产品研究', path: pagePath, snippet: '资料有出处、知识可连接、变更可审阅。', graphRelatedTo: ['用户旅程', '协作原则'] }], error: null, savedPath: null, revision: 1 };
        questionTasks.set(body.taskId, task);
        return { callId: 'a011a011a011a011a011a011a011a011', accepted: true };
      }
      case 'qa/task': return { projectId: requestedProjectId, task: questionTasks.get(body.taskId || url.searchParams.get('taskId')) || null };
      default: return undefined;
    }
  }
  if (pathname === '/api/world/query') {
    const kind = body.query?.kind;
    const request = body.query?.request || {};
    let result;
    switch (kind) {
      case 'discover': result = description; break;
      case 'definitions': result = { items: empty ? [] : definitions }; break;
      case 'definition': result = definitions.find(item => item.reference.id === (request.reference?.id || request.id || request.definition?.id)); break;
      case 'materials': result = { items: empty ? [] : materials }; break;
      case 'packages': result = { items: empty ? [] : packages, nextCursor: null }; break;
      case 'connections': case 'action_proposals': case 'tasks': case 'suites': case 'branches': case 'evaluations': result = { items: [] }; break;
      case 'changes': result = { items: empty ? [] : changes }; break;
      case 'releases': result = { items: empty ? [] : releases }; break;
      case 'bindings': result = { items: [activationLock] }; break;
      case 'binding_head': result = { world, activationLockId: activationLock.id, channel: request.channel, generation: '1', revision: '1' }; break;
      case 'objects': result = empty ? { ...objects, objects: [] } : objects; break;
      case 'material_draft': result = { reference: materialDraft, baseRelease: releaseHead.releaseId, scope: 'research', parseArtifacts: ['parse-design-1'], sourceVersions: materials.map(item => item.reference), batch: { candidates: [], evidence: [], observations: [], coverage: [{ status: 'processed' }], readNeeds: [] } }; break;
      default: return undefined;
    }
    return { success: true, data: { kind, result } };
  }
  if (pathname === '/api/world/operation') {
    const kind = body.kind;
    const operationId = body.request?.operationId || accepted.operationId;
    const receipt = { ...operationReceipt, accepted: { ...accepted, operationId } };
    return { success: true, data: { kind, result: kind === 'resume' ? receipt.accepted : kind === 'cancel' ? { receipt, settled: true } : receipt } };
  }
  return undefined;
}

const tab = name => ({ role: 'tab', name, exact: true });
const button = name => ({ role: 'button', name, exact: true });
const openLibrary = async page => {
  await page.getByRole('button', { name: /产品研究资料库/ }).first().click();
  await page.getByRole('tab', { name: 'Wiki', exact: true }).waitFor();
};
const openPage = async page => {
  await openLibrary(page);
  await page.locator(`button[title="${pagePath}"]`).first().click();
};
const wikiReady = {
  library: '产品研究资料库',
  'library-empty': '无记录',
  'library-create': '最小设置，适合任何用途的空白资料库。',
  'library-search': '团队协作手册',
  wiki: '把用户访谈、产品假设和验证结果连接起来，形成可追溯的知识网络。',
  files: 'raw',
  edit: '预览',
  history: 'history-design-1',
  'page-links': '补齐访谈、观察与验证方法。',
  sources: '合成示例：来源解析需重新确认。',
  'sources-empty': '无来源文档',
  'sources-settings': '内置 all-MiniLM-L6-v2，固定 384 维',
  'sources-embedding-remote': '密钥未配置',
  review: '研究周期存在不同表述',
  'review-empty': '无 Review 项',
  qa: '选择模型并提出问题，回答会附带本次检索证据。',
  'qa-answer': '先保留原始访谈与研究记录，再把结论组织成可互相引用的知识页面。',
  lint: '研究方法尚未创建，可补充页面或调整链接。',
  'lint-rules': '忽略页面（每行一个，或以逗号分隔）',
  search: '关键词 3 · 向量 2 · 图谱 1',
  'search-context': '关键词 1 · 向量 1 · 图谱 1',
  'search-empty': '无结果',
  graph: '滚轮缩放 · 拖动平移 · 点选探索 · 双击打开',
  'graph-filters': '隐藏索引、总览等结构节点',
  'graph-list': '连接数',
  maintenance: '4 个文件，18 个版本',
  'maintenance-rebuild': '重建将重新生成 wiki/index.md 的分类目录',
  'maintenance-history-clear': '清空全部文件历史？',
};
const worldReady = {
  data: '仅当前已加载目录，不代表世界总量',
  switch: '打开世界',
  objects: '用户旅程研究',
  'objects-empty': '还没有对象类型，先添加资料并确认模型候选。',
  'object-detail': '读取回执与覆盖范围',
  materials: 'version-design-1',
  'materials-empty': '还没有资料，点击“添加资料”开始。',
  'materials-upload': '选择文件（最大 256 MiB）',
  'materials-wiki': 'Wiki 知识库',
  'materials-connection': '用户名（私有）',
  'materials-draft': '暂无待审候选。',
  actions: '发布研究摘要',
  'actions-create': '提案记录参数、目标与影响；生成提案不代表已经执行。',
  'model-canvas': '1..∞',
  'model-definition': 'project-name · project-stage',
  'model-version': '当前版本基线',
  'model-edit': '修改方式',
  'changes-pending': '统一项目名称和研究阶段的展示约定',
  'changes-detail': '变更前',
  'changes-evaluation': '暂无可读取的评测报告。已有验证分支时，可选择冻结套件开始评测。',
  'changes-evaluation-manage': '管理套件与测试（高级）',
  'changes-releases': '版本标识与绑定详情',
  'changes-rollback': '核验并回退',
  'settings-storage': '未找到此世界已保存的迁移请求。',
  'settings-capabilities': 'PostgreSQL 业务源',
  'settings-operations': '审阅草稿 · 修订 1',
};
const wiki = (id, title, actions = [], prepare = openLibrary) => ({ id: `wiki-${id}`, title, group: '知识库', route: '/wiki', sources: ['src/plugins/wiki/index.tsx', 'src/plugins/wiki/components/LibraryWorkspace.tsx'], actions, waitFor: wikiReady[id], ...(prepare ? { prepare } : {}) });
const worldScene = (id, title, route = '/world', actions = []) => ({ id: `world-${id}`, title, group: '世界', route, sources: ['src/pages/World/index.tsx'], actions, waitFor: worldReady[id] });
export const knowledgeScenarios = [
  wiki('library', '资料库首页', [], null),
  wiki('library-empty', '资料库首页 · 空状态', [], null),
  wiki('library-create', '新建资料库', [button('新建资料库')], null),
  wiki('library-search', '资料库搜索', [{ css: 'input[placeholder="搜索"]', fill: '团队' }], null),
  wiki('wiki', '知识导航与阅读', [], openPage),
  wiki('files', '文件导航', [button('文件')]),
  wiki('edit', '知识页面编辑', [button('编辑')], openPage),
  wiki('history', '文件历史', [button('文件历史')], openPage),
  wiki('page-links', '页面链接', [button('页面链接')], openPage),
  wiki('sources', '来源与处理任务', [tab('来源')]),
  wiki('sources-empty', '来源 · 空状态', [tab('来源')]),
  wiki('sources-settings', '来源设置', [tab('来源'), { css: 'main button[title="设置"]' }, { css: 'main summary:has-text("向量设置")' }]),
  wiki('sources-embedding-remote', '来源设置 · 远程向量模型', [tab('来源'), { css: 'main button[title="设置"]' }, { css: 'main summary:has-text("向量设置")' }]),
  wiki('review', 'Review 审阅', [tab('Review')]),
  wiki('review-empty', 'Review · 空状态', [tab('Review')]),
  wiki('qa', '知识问答', [tab('问答')]),
  wiki('qa-answer', '知识问答 · 回答与引用', [tab('问答'), { css: 'select[aria-label="回答模型"]', select: 'model:design-demo-openai-gpt-5.5' }, { css: 'textarea[aria-label="问题"]', fill: '研究资料如何形成知识？' }, button('发送问题')]),
  wiki('lint', '知识检查', [tab('检查')]),
  wiki('lint-rules', '知识检查规则', [tab('检查'), button('检查规则')]),
  wiki('search', '知识搜索', [tab('搜索'), { css: 'input[aria-label="搜索"]', fill: '研究' }, button('搜索')]),
  wiki('search-context', '知识检索上下文', [tab('搜索'), { css: 'input[aria-label="搜索"]', fill: '研究' }, button('上下文')]),
  wiki('search-empty', '知识搜索 · 无结果', [tab('搜索'), { css: 'input[aria-label="搜索"]', fill: '未收录主题' }, button('搜索')]),
  wiki('graph', '知识图谱', [tab('图谱'), button('读取')]),
  wiki('graph-filters', '知识图谱筛选', [tab('图谱'), button('读取'), button('筛选')]),
  wiki('graph-list', '知识图谱节点列表', [tab('图谱'), button('读取'), button('节点列表')]),
  wiki('maintenance', '知识库维护', [tab('维护')]),
  wiki('maintenance-rebuild', '重建分类索引确认', [tab('维护'), button('重建分类索引')]),
  wiki('maintenance-history-clear', '清空文件历史确认', [tab('维护'), button('清空全部历史')]),
  worldScene('data', '业务概览'),
  worldScene('switch', '切换世界', '/world', [button('切换世界')]),
  worldScene('objects', '对象查询', '/world', [button('探索对象')]),
  worldScene('objects-empty', '对象查询 · 空状态', '/world', [button('探索对象')]),
  worldScene('object-detail', '对象详情', '/world', [button('探索对象'), { css: 'button[title="project-design-1"]' }]),
  worldScene('materials', '资料与来源', '/world?tab=materials'),
  worldScene('materials-empty', '资料与来源 · 空状态', '/world?tab=materials'),
  worldScene('materials-upload', '上传资料', '/world?tab=materials&mode=upload'),
  worldScene('materials-wiki', '从 Wiki 导入', '/world?tab=materials&mode=wiki'),
  worldScene('materials-connection', '连接业务系统', '/world?tab=materials&mode=connection'),
  worldScene('materials-draft', '审阅资料草稿', '/world?tab=materials&mode=draft'),
  worldScene('actions', '业务操作', '/world?tab=actions'),
  worldScene('actions-create', '发起业务操作', '/world?tab=actions', [button('发起操作')]),
  worldScene('model-canvas', '业务模型 · 关系画布', '/world/model'),
  worldScene('model-definition', '业务模型 · 定义', '/world/model', [tab('定义')]),
  worldScene('model-version', '业务模型 · 版本与编译基线', '/world/model', [tab('版本与编译基线')]),
  worldScene('model-edit', '提出定义修改', '/world/model', [tab('定义'), { role: 'button', name: '提出修改', exact: true, index: 0 }]),
  worldScene('changes-pending', '待审变更', '/world/changes'),
  { ...worldScene('changes-detail', '待审变更详情', '/world/changes'), prepare: async page => { await page.getByRole('button', { name: /统一项目名称和研究阶段的展示约定/ }).click(); } },
  worldScene('changes-evaluation', '验证与评测', '/world/changes', [tab('验证与评测')]),
  worldScene('changes-evaluation-manage', '运行评测与管理测试', '/world/changes', [tab('验证与评测'), button('运行评测 / 管理测试')]),
  worldScene('changes-releases', '发布记录', '/world/changes', [tab('发布记录')]),
  worldScene('changes-rollback', '回退到历史版本', '/world/changes', [tab('发布记录'), button('回退到历史版本')]),
  worldScene('settings-storage', '世界存储与初始化', '/world/settings'),
  worldScene('settings-capabilities', '世界能力扩展', '/world/settings?tab=capabilities'),
  worldScene('settings-operations', '世界处理记录', '/world/settings?tab=operations'),
];

export async function seedKnowledge(context = {}) {
  const id = context.scenarioId || '';
  if (!id.startsWith('wiki-') && !id.startsWith('world-')) return;
  if (id.startsWith('wiki-')) {
    const { useWikiProjectsStore } = await import('/src/plugins/wiki/wiki-projects.ts');
    const empty = id === 'wiki-library-empty';
    useWikiProjectsStore.setState({ projects: empty ? [] : projects, currentProject: empty ? null : projects[0], loading: false, switching: false, ready: true });
    return;
  }
  const { useWorldStore } = await import('/src/stores/world/index.ts');
  useWorldStore.setState({ world, description, definitions, materials, connections: [], proposals: [], changes, evaluations: [], operations: [accepted], actionSubmissions: [], objects: null, selectedType: null, materialDraft: id === 'world-materials-draft' ? materialDraft : null, loading: false, busy: false, operationBusy: false, pending: null, pendingOperation: null, upload: null, error: null, notice: null, storageTransfer: null, transferBusy: false });
}

export function knowledgeIpc(channel, args, context = {}) {
  switch (channel) {
    case 'world:storageStatus': return { outcome: 'available', configured: true, initialStorageId: 'design-storage-primary', targetStorageIds: ['design-storage-archive'], registeredTargetStorageIds: ['design-storage-archive'] };
    case 'world:configureStorage': return { outcome: 'saved', storageId: 'design-storage-archive', restartRequired: true };
    case 'world:transferStorage': return context.scenarioId === 'world-settings-transfer' ? { outcome: 'status', transfer: { world, transferId: 'transfer-design-1', targetStorageId: 'design-storage-archive', phase: 'prepared', action: 'resume' } } : { outcome: 'not-found' };
    default: return undefined;
  }
}
