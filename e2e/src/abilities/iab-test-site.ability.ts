import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';

type PreparedSite = { baseUrl: string; uploadPath: string; downloadText: string };
type Respond = (status: string, body: string, headers?: Record<string, string>) => void;
type Worker = 'a' | 'b';
type WorkerResults = Record<Worker, { readyAt: number | null; completedAt: number | null; answer: string | null }> & { releaseBAt: number | null };
export type StressCase = 'independent' | 'fanout' | 'contention' | 'cancel' | 'handoff' | 'navigation';
export type StressWorker = 'a' | 'b' | 'c' | 'd';
type StressWorkerResult = {
  readyAt: number | null; completedAt: number | null; answer: string | null;
  readyCount: number; completedCount: number; visits: number; gateOpen: boolean;
  events: { action: 'ready' | 'complete'; answer: string; document: number; at: number }[];
};
type StressResults = { workers: Record<StressWorker, StressWorkerResult>; finished: boolean };
const stressCases: StressCase[] = ['independent', 'fanout', 'contention', 'cancel', 'handoff', 'navigation'];
const stressWorkers: StressWorker[] = ['a', 'b', 'c', 'd'];

function stressState(): StressResults {
  const worker = (): StressWorkerResult => ({
    readyAt: null, completedAt: null, answer: null, readyCount: 0, completedCount: 0, visits: 0, gateOpen: false, events: [],
  });
  return { workers: { a: worker(), b: worker(), c: worker(), d: worker() }, finished: false };
}

const downloadText = 'IAB download 中文 fixture\n';
const maxHeaderBytes = 16_384;
const maxBodyBytes = 4_096;

function html(title: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:16px;font-family:sans-serif}label,input,button,select,a{margin:4px}output{white-space:pre-wrap}</style>
</head><body><h1>${title}</h1>${content}</body></html>`;
}

const home = html('IAB E2E Home', `
<style>body{min-height:1600px;box-sizing:border-box;display:flex;flex-direction:column}footer{margin-top:auto}</style>
<nav><a id="ordinary" href="/second">普通</a><a id="new-tab" target="_blank" href="/child">新标签页</a></nav>
<p><label for="text">中文输入</label><input id="text" maxlength="256"><button id="apply" type="button">应用</button><output id="applied" aria-live="polite"></output></p>
<p><label for="paste">粘贴输入</label><input id="paste" maxlength="256"></p>
<p><label for="check"><input id="check" type="checkbox">复选框</label>
<label for="choice">选择</label><select id="choice"><option value="one">one</option><option value="two">two</option></select></p>
<p><label for="upload">上传文件</label><input id="upload" type="file"><output id="uploaded" aria-live="polite"></output></p>
<nav><a id="download" href="/download">下载</a><a id="login" href="/login">登录</a></nav>
<p>IAB-FIND-TOKEN</p><p>IAB-FIND-TOKEN</p><p>IAB-FIND-TOKEN</p>
<footer><button id="bottom" type="button">底部按钮</button><output id="bottom-result" aria-live="polite"></output></footer>
<script>
document.getElementById('apply').addEventListener('click', () => {
  document.getElementById('applied').textContent = document.getElementById('text').value;
});
document.getElementById('upload').addEventListener('change', async () => {
  const file = document.getElementById('upload').files[0];
  document.getElementById('uploaded').textContent = file ? file.name + ': ' + await file.text() : '';
});
document.getElementById('bottom').addEventListener('click', () => {
  document.getElementById('bottom-result').textContent = 'clicked';
});
</script>`);

const login = html('IAB E2E Login', `
<form action="/login" method="post" accept-charset="UTF-8">
<p><label for="username">用户名</label><input id="username" name="username" autocomplete="username" maxlength="64" required></p>
<p><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="64" required></p>
<button type="submit">登录</button></form>`);

const workerStatePolling = `
async function poll() {
  try {
    const response = await fetch('/agent-worker-state', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
  } catch (error) { result.textContent = error.message; }
  setTimeout(poll, 300);
}
void poll();`;

function workerPage(worker: Worker, challenge: string): string {
  return html(`IAB Agent Worker ${worker.toUpperCase()}`, `
<p>页面验证码：<strong id="challenge">${challenge}</strong></p>
<label for="answer">输入页面验证码</label><input id="answer" maxlength="64">
<button id="ready" type="button">登记就绪</button><button id="complete" type="button" disabled>提交结果</button>
<output id="gate" aria-live="polite">等待双方就绪</output><output id="result" aria-live="polite"></output>
<script>
const worker = ${JSON.stringify(worker)};
const ready = document.getElementById('ready'), complete = document.getElementById('complete'), result = document.getElementById('result');
function render(state) {
  const current = state[worker], completed = current.completedAt !== null;
  const canComplete = state.a.readyAt !== null && state.b.readyAt !== null && (worker === 'a' || state.releaseBAt !== null);
  ready.disabled = current.readyAt !== null; complete.disabled = completed || !canComplete;
  document.getElementById('gate').textContent = completed ? '已完成' : canComplete ? '可以提交' : worker === 'b' && current.readyAt !== null ? '等待A完成' : '等待双方就绪';
  if (completed) result.textContent = '验证通过';
}
async function post(action) {
  try {
    result.textContent = '';
    const response = await fetch(location.pathname + '/' + action, { method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ answer: document.getElementById('answer').value }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
  } catch (error) { result.textContent = error.message; }
}
ready.addEventListener('click', () => post('ready')); complete.addEventListener('click', () => post('complete'));
${workerStatePolling}
</script>`);
}

function stressPage(testCase: StressCase, worker: StressWorker, challenge: string, document: number): string {
  return html(`IAB Agent Stress ${testCase} ${worker.toUpperCase()}`, `
<p>页面验证码：<strong id="challenge">${challenge}</strong></p><p>文档代际：<output id="document">${document}</output></p>
<label for="answer">输入页面验证码</label><input id="answer" maxlength="64">
<button id="ready" type="button">登记就绪</button><button id="complete" type="button" disabled>提交结果</button>
<output id="gate" aria-live="polite">等待放行</output><output id="result" aria-live="polite"></output><output id="wait-polls" hidden>0</output>
<script>
const result = document.getElementById('result'), complete = document.getElementById('complete');
window.iabStressWait = () => {
  const polls = document.getElementById('wait-polls');
  polls.textContent = String(Number(polls.textContent) + 1);
  return document.getElementById('gate').textContent === '可以提交';
};
function render(state) {
  const current = state.workers[${JSON.stringify(worker)}];
  complete.disabled = !current.gateOpen;
  document.getElementById('gate').textContent = current.gateOpen ? '可以提交' : '等待放行';
}
async function post(action) {
  try {
    const response = await fetch(location.pathname + '/' + action, { method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ answer: document.getElementById('answer').value, document: ${JSON.stringify(String(document))} }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
    result.textContent = action === 'complete' ? '验证通过' : '已登记';
  } catch (error) { result.textContent = error.message; }
}
document.getElementById('ready').addEventListener('click', () => post('ready'));
complete.addEventListener('click', () => post('complete'));
async function poll() {
  try {
    const response = await fetch('/agent-stress/${testCase}/state', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
  } catch (error) { result.textContent = error.message; }
  setTimeout(poll, 300);
}
void poll();
</script>`);
}

function stressRoute(method: string, target: string, headers: Map<string, string>, body: string, respond: Respond,
  challenges: Record<StressCase, Record<StressWorker, string>>, states: Record<StressCase, StressResults>): boolean {
  const match = /^\/agent-stress\/(independent|fanout|contention|cancel|handoff|navigation)\/(state|coordinator|a|b|c|d)(?:\/(ready|complete))?(?:\?document=next)?$/.exec(target);
  if (!match) return false;
  const testCase = match[1] as StressCase, worker = match[2], action = match[3], state = states[testCase];
  if (method === 'GET' && worker === 'state' && !action) respond('200 OK', JSON.stringify(state), { 'Content-Type': 'application/json; charset=utf-8' });
  else if (method === 'GET' && worker === 'coordinator' && !action) respond('200 OK', html(`IAB Agent Stress ${testCase} Coordinator`, `
<output id="gate" aria-live="polite">等待子任务</output><output id="all-ready"></output><output id="a-completed"></output><output id="result"></output>
<script>
const result = document.getElementById('result');
function render(state) {
  document.getElementById('gate').textContent = state.finished ? '全部完成' : state.workers.a.readyAt !== null ? 'A已就绪' : '等待子任务';
  document.getElementById('all-ready').textContent = Object.values(state.workers).every(worker => worker.readyAt !== null) ? '全部就绪' : '';
  document.getElementById('a-completed').textContent = state.workers.a.completedAt !== null ? 'A已完成' : '';
}
${workerStatePolling.replace("'/agent-worker-state'", JSON.stringify(`/agent-stress/${testCase}/state`))}
</script>`));
  else if (stressWorkers.includes(worker as StressWorker)) {
    const id = worker as StressWorker, current = state.workers[id];
    if (method === 'GET' && !action) respond('200 OK', stressPage(testCase, id, challenges[testCase][id], ++current.visits));
    else if (method !== 'POST' || !action) respond('405 Method Not Allowed', 'Unsupported stress action');
    else if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') respond('415 Unsupported Media Type', 'Expected a form');
    else {
      const form = new URLSearchParams(body), answer = form.get('answer'), document = Number(form.get('document'));
      if ([...form.keys()].sort().join(',') !== 'answer,document' || answer !== challenges[testCase][id]
        || !Number.isSafeInteger(document) || document < 1 || document > current.visits) respond('422 Unprocessable Entity', '验证码或文档代际不匹配');
      else if (action === 'complete' && !current.gateOpen) respond('409 Conflict', '尚未允许提交');
      else {
        const at = Date.now();
        current.events.push({ action: action as 'ready' | 'complete', answer, document, at });
        current.answer = answer;
        if (action === 'ready') { current.readyAt ??= at; current.readyCount++; }
        else { current.completedAt ??= at; current.completedCount++; }
        respond('200 OK', JSON.stringify(state), { 'Content-Type': 'application/json; charset=utf-8' });
      }
    }
  } else respond('405 Method Not Allowed', 'Unsupported stress route');
  return true;
}

function route(method: string, target: string, headers: Map<string, string>, body: string, respond: Respond, downloadName: string, challenge: string,
  workerChallenges: Record<Worker, string>, results: WorkerResults,
  stressChallenges: Record<StressCase, Record<StressWorker, string>>, stressStates: Record<StressCase, StressResults>): void {
  if (stressRoute(method, target, headers, body, respond, stressChallenges, stressStates)) return;
  if (method === 'GET' && target === '/agent-worker-state') return respond('200 OK', JSON.stringify(results), { 'Content-Type': 'application/json; charset=utf-8' });
  if (method === 'GET' && target === '/agent-complex') return respond('200 OK', home.replaceAll('IAB E2E Home', 'IAB Agent Complex').replace('id="ordinary" href="/second"', 'id="ordinary" href="/agent"'));
  if (method === 'GET' && target === '/agent-coordinator') return respond('200 OK', html('IAB Agent Coordinator', `
<output id="gate" aria-live="polite">等待子任务</output><output id="result" aria-live="polite"></output>
<script>
const result = document.getElementById('result');
function render(state) { document.getElementById('gate').textContent = state.a.completedAt !== null && state.b.completedAt !== null ? '全部完成' : '等待子任务'; }
${workerStatePolling}
</script>`));
  const workerRoute = /^\/agent-worker\/(a|b)(?:\/(ready|complete))?$/.exec(target);
  if (workerRoute) {
    const worker = workerRoute[1] as Worker, action = workerRoute[2], current = results[worker];
    if (method === 'GET' && !action) return respond('200 OK', workerPage(worker, workerChallenges[worker]));
    if (method !== 'POST' || !action) return respond('405 Method Not Allowed', 'Unsupported worker action');
    if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return respond('415 Unsupported Media Type', 'Expected a form');
    const form = new URLSearchParams(body), answer = form.get('answer');
    if ([...form.keys()].join(',') !== 'answer' || answer !== workerChallenges[worker]) return respond('422 Unprocessable Entity', '验证码不匹配');
    if (action === 'ready') current.readyAt ??= Date.now();
    else {
      if (results.a.readyAt === null || results.b.readyAt === null || (worker === 'b' && results.releaseBAt === null)) return respond('409 Conflict', '尚未允许提交');
      current.completedAt ??= Date.now(); current.answer = answer;
    }
    return respond('200 OK', JSON.stringify(results), { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (method === 'POST' && target === '/login') {
    if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      return respond('415 Unsupported Media Type', 'Expected a form');
    }
    const form = new URLSearchParams(body);
    if ([...form.keys()].sort().join(',') !== 'password,username'
      || form.get('username') !== 'iaptester' || form.get('password') !== 'fixture-only') {
      return respond('401 Unauthorized', login);
    }
    return respond('303 See Other', '', {
      'Set-Cookie': 'iab_fixture=authenticated; Path=/; HttpOnly; SameSite=Lax',
      Location: '/account?seed=1',
    });
  }
  if (method !== 'GET') return respond('405 Method Not Allowed', 'GET or POST /login only');
  switch (target) {
    case '/': return respond('200 OK', home);
    case '/second': return respond('200 OK', html('IAB E2E Second', '<a id="home" href="/">首页</a>'));
    case '/child': return respond('200 OK', html('IAB E2E Child', ''));
    case '/agent': return respond('200 OK', html('IAB Agent Challenge', `
<p>页面验证码：<strong id="challenge">${challenge}</strong></p>
<label for="answer">输入页面验证码</label><input id="answer" maxlength="64">
<button id="confirm" type="button">验证输入</button><output id="result" aria-live="polite"></output>
<p><a href="/agent-child" target="_blank">打开验收子页</a></p>
<script>document.getElementById('confirm').addEventListener('click', () => {
  document.getElementById('result').textContent = document.getElementById('answer').value === document.getElementById('challenge').textContent ? '验证通过' : '验证码不匹配';
});</script>`));
    case '/agent-child': return respond('200 OK', html('IAB Agent Child', '<p id="child-proof">子页已打开</p>'));
    case '/login': return respond('200 OK', login);
    case '/download': return respond('200 OK', downloadText, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename=${downloadName}`,
    });
    case '/account':
    case '/account?seed=1': {
      const authenticated = headers.get('cookie')?.split(';').some(cookie => cookie.trim() === 'iab_fixture=authenticated') ?? false;
      const seed = authenticated && target === '/account?seed=1';
      return respond('200 OK', html('IAB E2E Account', `
<p id="auth">${authenticated ? 'authenticated' : 'anonymous'}</p><output id="storage"></output>
<script>
${seed ? "localStorage.setItem('iab_fixture', 'authenticated');" : ''}
document.getElementById('storage').textContent = localStorage.getItem('iab_fixture') === null ? 'missing' : 'present';
</script>`));
    }
    default: return respond('404 Not Found', 'Not found');
  }
}

export class IabTestSite extends Ability {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private preparation?: Promise<PreparedSite>;
  private closed = false;
  private downloadName = '';
  readonly agentChallenge = `中文-${randomUUID().slice(0, 8)}`;
  private readonly workerChallenges = { a: `甲-${randomUUID().slice(0, 8)}`, b: `乙-${randomUUID().slice(0, 8)}` };
  private readonly results: WorkerResults = {
    a: { readyAt: null, completedAt: null, answer: null }, b: { readyAt: null, completedAt: null, answer: null }, releaseBAt: null,
  };

  private readonly stressChallenges = Object.fromEntries(stressCases.map(testCase => [testCase,
    Object.fromEntries(stressWorkers.map(worker => [worker, `${testCase}-${worker}-${randomUUID().slice(0, 8)}`])),
  ])) as Record<StressCase, Record<StressWorker, string>>;
  private readonly stressStates: Record<StressCase, StressResults> = {
    independent: stressState(), fanout: stressState(), contention: stressState(), cancel: stressState(), handoff: stressState(), navigation: stressState(),
  };

  stressChallenge(testCase: StressCase, worker: StressWorker): string { return this.stressChallenges[testCase][worker]; }
  stressResults(testCase: StressCase): StressResults { return structuredClone(this.stressStates[testCase]); }
  releaseStress(testCase: StressCase, worker: StressWorker): void {
    const state = this.stressStates[testCase].workers[worker];
    if (state.readyAt === null || state.gateOpen) throw new Error('Stress worker must be ready and not previously released');
    state.gateOpen = true;
  }
  finishStress(testCase: StressCase): void { this.stressStates[testCase].finished = true; }

  workerChallenge(worker: Worker): string { return this.workerChallenges[worker]; }
  workerResults(): WorkerResults { return { a: { ...this.results.a }, b: { ...this.results.b }, releaseBAt: this.results.releaseBAt }; }
  releaseWorkerB(): void {
    if (this.results.a.completedAt === null || this.results.b.readyAt === null) throw new Error('Worker B requires A completed and B ready before release');
    this.results.releaseBAt = Date.now();
  }

  get downloadFilename(): string { return this.downloadName; }

  constructor(private readonly outputRoot: string, private readonly profileRoot: string) { super(); }

  async prepare(): Promise<{ baseUrl: string; uploadPath: string; downloadText: string }> {
    if (this.closed) throw new Error('IAB test site is closed');
    this.preparation ??= this.start();
    return { ...await this.preparation };
  }

  async close(): Promise<void> {
    this.closed = true;
    // Preparation failures remain with the caller; teardown must still release owned sockets.
    await this.preparation?.catch(() => undefined);
    const server = this.server;
    if (!server?.listening) return;
    const closing = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    for (const socket of this.sockets) socket.destroy();
    await closing;
  }

  private async start(): Promise<PreparedSite> {
    if (!isAbsolute(this.outputRoot) || !isAbsolute(this.profileRoot)) {
      throw new Error('IAB test site requires absolute fixture-owned output and profile paths');
    }
    await mkdir(this.outputRoot, { recursive: true });
    const directory = await mkdtemp(join(this.outputRoot, 'iab-test-site-'));
    this.downloadName = `iab-e2e-${directory.slice(directory.lastIndexOf('-') + 1)}.txt`;
    const uploadPath = join(directory, 'upload.txt');
    await writeFile(uploadPath, 'IAB upload 中文 fixture\n', { encoding: 'utf8', flag: 'wx' });
    const server = createServer(socket => this.serve(socket));
    this.server = server;
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        accept();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('IAB test site could not bind its own loopback port');
    return { baseUrl: `http://127.0.0.1:${address.port}`, uploadPath, downloadText };
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    let incoming = Buffer.alloc(0);
    const respond: Respond = (status, body, headers = {}) => {
      socket.off('data', receive);
      const responseHeaders = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        Connection: 'close',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      };
      socket.end([`HTTP/1.1 ${status}`, ...Object.entries(responseHeaders).map(([name, value]) => `${name}: ${value}`), '', body].join('\r\n'));
    };
    // ponytail: one bounded Content-Length request per connection; chunked/persistent HTTP needs a real HTTP owner.
    const receive = (chunk: Buffer): void => {
      if (incoming.length + chunk.length > maxHeaderBytes + 4 + maxBodyBytes) {
        return respond('413 Payload Too Large', 'Request too large');
      }
      incoming = Buffer.concat([incoming, chunk]);
      const headerEnd = incoming.indexOf('\r\n\r\n');
      if (headerEnd === -1 || headerEnd > maxHeaderBytes) {
        if (incoming.length > maxHeaderBytes) respond('431 Request Header Fields Too Large', 'Headers too large');
        return;
      }
      const lines = incoming.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const request = /^(GET|POST) (\/[^\s#]*) HTTP\/1\.1$/.exec(lines.shift() ?? '');
      if (!request) return respond('400 Bad Request', 'Invalid request line');
      const headers = new Map<string, string>();
      for (const line of lines) {
        const field = /^([!#$%&'*+.^_`|~\da-z-]+):[ \t]*([^\r\n]*)$/i.exec(line);
        const name = field?.[1].toLowerCase();
        if (!field || !name || headers.has(name)) return respond('400 Bad Request', 'Invalid or duplicate header');
        headers.set(name, field[2].trim());
      }
      const length = headers.get('content-length');
      if (headers.get('host') !== `127.0.0.1:${socket.localPort}` || headers.has('transfer-encoding')
        || (length !== undefined && !/^\d{1,5}$/.test(length))) {
        return respond('400 Bad Request', 'Invalid host or request framing');
      }
      const bodyBytes = Number(length ?? 0);
      if (bodyBytes > maxBodyBytes) return respond('413 Payload Too Large', 'Body too large');
      if (request[1] === 'GET' && bodyBytes !== 0) return respond('400 Bad Request', 'GET body is not supported');
      if (request[1] === 'POST' && length === undefined) return respond('411 Length Required', 'Content-Length required');
      if (incoming.length < headerEnd + 4 + bodyBytes) return;
      route(request[1], request[2], headers, incoming.subarray(headerEnd + 4, headerEnd + 4 + bodyBytes).toString('utf8'), respond,
        this.downloadName, this.agentChallenge, this.workerChallenges, this.results, this.stressChallenges, this.stressStates);
    };
    socket.on('data', receive);
  }
}
