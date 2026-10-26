import { mkdir, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { exportSnapshot } from './snapshot.mjs';
import { addNavigation, scopeNavigation } from './navigation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'design/frontend-pages');
const names = ['chat', 'settings', 'workflows', 'tools', 'fleet', 'knowledge', 'account-providers'];
const modules = await Promise.all(names.map((name) => import(`./${name}.mjs`)));
const scenes = modules.flatMap((module) => Object.entries(module).filter(([name]) => name.endsWith('Scenarios')).flatMap(([, value]) => value));
const filter = process.argv.indexOf('--only');
const selected = filter < 0 ? scenes : scenes.filter((scene) => process.argv[filter + 1].split(',').some((part) => scene.id.includes(part)));
const ids = new Set();
for (const scene of scenes) {
  if (!/^[a-z0-9][a-z0-9-]+$/.test(scene.id) || ids.has(scene.id)) throw new Error(`Invalid/duplicate scene: ${scene.id}`);
  ids.add(scene.id);
  if (!scene.title || !scene.group || !scene.route || !scene.sources?.length) throw new Error(`Incomplete scene metadata: ${scene.id}`);
  for (const source of scene.sources) if (!existsSync(join(root, source))) throw new Error(`Missing source: ${source}`);
}
if (!selected.length) throw new Error('No matching scenes');
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(scenes.map(({ id, title, group, route, sources }) => ({ id, title, group, route, sources })), null, 2));
  process.exit(0);
}
await mkdir(join(output, 'verification'), { recursive: true });
const navigationOnly = process.argv.includes('--navigation-only');
const server = navigationOnly ? null : await createServer({
  configFile: false, root, cacheDir: join(root, '.scratch/design-export-vite-cache'),
  plugins: [react()], resolve: { alias: { '@': join(root, 'src'), '@electron': join(root, 'electron') } },
  optimizeDeps: { entries: ['scripts/design-export/index.html'] },
  server: { host: '127.0.0.1', port: 0, watch: null },
});
const report = { generatedAt: new Date().toISOString(), viewport: { width: 1440, height: 960 }, data: 'synthetic-only', scenes: [], failures: [] };
let browser;
try {
  if (navigationOnly) {
    await updateNavigation();
  } else {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ ...(existsSync(edge) ? { executablePath: edge } : {}), headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  for (const scene of selected) {
    const result = { id: scene.id, title: scene.title, group: scene.group, route: scene.route, sources: scene.sources, errors: [], missing: [], externalRequests: [] };
    const context = await browser.newContext({ viewport: report.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    let baseline;
    let appliedDockWidth = 0;
    await page.exposeBinding('__designResizeDock', async (_source, width, options = {}) => {
      const current = page.viewportSize();
      const previous = options.currentDockWidth ?? appliedDockWidth;
      if (options.resizeWindow !== false) await page.setViewportSize({ width: Math.max(480, current.width + width - previous), height: current.height });
      appliedDockWidth = width;
      return { appliedWidth: width };
    });
    await page.routeWebSocket(/.*/, (socket) => {
      if (socket.url().startsWith(`${origin.replace('http:', 'ws:')}/`)) socket.connectToServer();
      else { result.externalRequests.push(socket.url()); socket.close(); }
    });
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => result.errors.push(error.message));
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) return route.continue();
      result.externalRequests.push(url);
      return route.abort();
    });
    try {
      await page.goto(`${origin}/scripts/design-export/index.html?scene=${scene.id}#${scene.route}`, { timeout: 120000 });
      await page.waitForFunction(() => window.__design?.ready || window.__design?.error, undefined, { timeout: 60000 });
      const initError = await page.evaluate(() => window.__design.error);
      if (initError) throw new Error(initError);
      await page.waitForFunction(() => document.querySelector('#root')?.textContent?.trim().length > 30, undefined, { timeout: 30000 });
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}' });
      if (scene.prepare) await scene.prepare(page);
      for (const action of scene.actions ?? []) {
        let locator = action.css ? page.locator(action.css) : page.getByRole(action.role, { name: action.name, exact: action.exact ?? true });
        if (action.index !== undefined) locator = locator.nth(action.index);
        if (action.fill !== undefined) await locator.fill(action.fill);
        else if (action.select !== undefined) await locator.selectOption(action.select);
        else if (action.check !== undefined) await locator.setChecked(action.check);
        else await locator.click();
      }
      if (scene.waitFor) await page.getByText(scene.waitFor, { exact: false }).filter({ visible: true }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400);
      if (await page.getByText('Something went wrong', { exact: true }).count()) throw new Error('React error boundary rendered');
      result.missing = await page.evaluate(() => window.__design.missing);
      result.fixtureErrors = await page.evaluate(() => window.__design.fixtureErrors);
      if (result.errors.length || result.missing.length || result.fixtureErrors.length || result.externalRequests.length) throw new Error('Renderer/fixture/network check failed');
      result.viewport = page.viewportSize();
      result.snapshot = await exportSnapshot(page, { ...scene, outputFile: join(output, `${scene.id}.html`), pages: scenes.map(({ id, title, group, route, sources }) => ({ id, title, group, route, sources })) });
      baseline = await page.screenshot({ animations: 'disabled' });
      const offline = await context.newPage();
      offline.on('pageerror', (error) => result.errors.push(`Offline: ${error.message}`));
      await offline.setViewportSize(result.viewport);
      await offline.goto(pathToFileURL(join(output, `${scene.id}.html`)).href);
      await offline.waitForFunction(() => window.__designSnapshotReady || window.__designSnapshotError);
      const snapshotError = await offline.evaluate(() => window.__designSnapshotError);
      if (snapshotError) throw new Error(`Offline restore failed: ${snapshotError}`);
      await offline.locator('[data-design-tools]').evaluateAll((nodes) => nodes.forEach((node) => { node.style.display = 'none'; }));
      await offline.waitForTimeout(100);
      if (result.errors.length) throw new Error(`Offline renderer errors: ${result.errors.join('; ')}`);
      const snapshot = await offline.screenshot({ path: join(output, 'verification', `${scene.id}.png`), animations: 'disabled' });
      const [a, b] = await Promise.all([sharp(baseline).ensureAlpha().raw().toBuffer(), sharp(snapshot).ensureAlpha().raw().toBuffer()]);
      let changedPixels = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changedPixels++;
      result.pixelDiff = { changedPixels, totalPixels: result.viewport.width * result.viewport.height, ratio: changedPixels / (result.viewport.width * result.viewport.height) };
      await offline.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
      result.darkTheme = await offline.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim() === '0 0% 10%');
      const dependencies = await offline.evaluate(() => [...document.querySelectorAll('img[src],link[href],script[src]')].map((node) => node.getAttribute('src') ?? node.getAttribute('href')).filter((url) => url && !url.startsWith('data:') && !url.startsWith('#')));
      if (dependencies.length) throw new Error(`Non-inline asset dependencies: ${dependencies.join(', ')}`);
      const brokenImages = await offline.evaluate(() => [...document.images].filter((image) => image.hasAttribute('src') && (!image.complete || !image.naturalWidth)).map((image) => image.getAttribute('alt') || image.tagName));
      if (brokenImages.length) throw new Error(`Broken offline images: ${brokenImages.join(', ')}`);
      if (!result.darkTheme) throw new Error('Dark theme tokens missing');
      result.missing = await page.evaluate(() => window.__design.missing);
      result.fixtureErrors = await page.evaluate(() => window.__design.fixtureErrors);
      if (result.errors.length || result.missing.length || result.fixtureErrors.length || result.externalRequests.length) throw new Error('Renderer/fixture/network check failed');
      if (result.pixelDiff.ratio > 0.001) throw new Error(`Offline visual mismatch: ${changedPixels} pixels (${(result.pixelDiff.ratio * 100).toFixed(3)}%)`);
      result.status = 'passed';
      result.verifiedAt = new Date().toISOString();
      await offline.close();
      console.log(`PASS ${scene.id} (${changedPixels} changed pixels)`);
    } catch (error) {
      result.status = 'failed';
      result.failure = error.stack ?? String(error);
      result.missing = await page.evaluate(() => window.__design?.missing ?? []).catch(() => []);
      result.fixtureErrors = await page.evaluate(() => window.__design?.fixtureErrors ?? []).catch(() => []);
      if (baseline) await writeFile(join(output, 'verification', `${scene.id}-source.png`), baseline);
      await page.screenshot({ path: join(output, 'verification', `${scene.id}-failure.png`), animations: 'disabled' }).catch(() => {});
      report.failures.push(scene.id);
      console.error(`FAIL ${scene.id}: ${String(error).split('\n')[0]} ${result.missing.join('; ')}`);
    } finally {
      report.scenes.push(result);
      await writeFile(join(output, 'verification', 'latest-run.json'), JSON.stringify(report, null, 2));
      await context.close();
    }
  }
  }
} finally {
  await browser?.close();
  await server?.close();
}

const evidence = new Map();
const previous = join(output, 'manifest.json');
if (existsSync(previous)) for (const item of JSON.parse(await readFile(previous, 'utf8')).pages) evidence.set(item.id, item);
for (const result of report.scenes) evidence.set(result.id, result);
const pages = scenes.map(({ id, title, group, route, sources, notes }) => ({ ...(evidence.get(id) ?? { status: 'not-exported' }), id, title, group, route, sources, ...(notes ? { notes } : {}) }));
await writeFile(previous, JSON.stringify({ generatedAt: report.generatedAt, viewport: report.viewport, data: report.data, pages }, null, 2));
for (const name of ['PRODUCT.md', 'DESIGN.md']) await copyFile(join(root, name), join(output, name));
await writeFile(join(output, 'theme-tokens.css'), await readFile(join(root, 'src/styles/globals.css'), 'utf8'));
await writeFile(join(output, 'index.html'), createIndex(pages));
await writeFile(join(output, 'README.md'), `# MatchaClaw 前端 HTML 设计交接包\n\n直接打开 index.html，从目录选择页面。每个 HTML 都是当前真实 React 组件的 DOM 与样式快照，可单独发送和离线打开，不需要 Node、服务器、CDN 或账户。\n\n## 修改与交回\n\n1. 将目标 HTML、DESIGN.md、PRODUCT.md 一起交给设计方。\n2. 直接改 HTML 中的语义 DOM、CSS 和内联 SVG，不要把页面变成整张图片，不要删掉 head 内的 design-snapshot-metadata。\n3. 定稿后交回改过的 HTML；涉及多个页签或弹窗时，将相应 HTML 一起返回，并说明共享组件需要统一的改动。\n   产品文案回填 React 时必须复用或新增 i18n 翻译键，同步现有语言资源，不能把 HTML 中已翻译的中文硬编码进组件；示例业务数据不当作翻译键。\n4. 以浏览器实际呈现为准。默认基准窗口 1440 × 960、缩放100%、Windows字体环境；聊天右栏会按真实扩窗行为增宽，以HTML元数据和manifest记录的viewport为准。右下角工具只用于目录和主题，不属于产品设计。\n\n## 内容与边界\n\n- 页面/页签/重要弹层分别存为独立HTML。侧栏、主要页签和已有对应快照的入口可点击本地跳转；右下“设计”工具还可按分组切换全部页面。其余React业务交互不随快照保留，不会连接真实服务、提交支付或保存数据。请先解压ZIP再打开index.html；只单独发送一份HTML时，指向其他文件的链接需要目标HTML一并发送。分组包仅在组内跳转，跨组入口需使用完整包。\n- 全部业务内容为新造的合成示例，不读取真实账号、授权码、密钥、聊天记录或用户profile。资料链接使用example.test。\n- 原应用未内置Inter字体文件，使用相同CSS字体栈和系统回退；不同操作系统的字形可能不同。不要假设任意机器像素一致。\n- 原生终端/Canvas若转换为局部PNG，在manifest的snapshot.canvasCount中登记；其外层布局与文本仍可编辑。品牌logo以gzip压缩原始SVG内嵌，打开时由浏览器原生解压，保持矢量；请使用支持DecompressionStream的现代Chrome、Edge或Firefox，页面本身不是截图。\n- manifest.json保留页面到源码的映射、覆盖状态和逐页验证结果；本地verification/保存离线截图与失败证据，不放入交接ZIP。验证逐像素比较源页面与离线HTML，差异占比超过0.1%会失败；通过不等于所有页面都是0像素差，具体见pixelDiff。浅深主题通过页面工具切换。\n- theme-tokens.css是原始主题样式参考，不是独立可加载的Tailwind产物；每个HTML已内联编译后的实际CSS。\n\n## 重新导出\n\n在项目根目录执行：\n\n\`\`\`bash\nnode --max-old-space-size=1536 scripts/design-export/export.mjs\n# 定向更新某个页面族\nnode --max-old-space-size=1536 scripts/design-export/export.mjs --only settings-,providers-\n# 只更新已有HTML的离线导航，逐页校验视觉不变\nnode --max-old-space-size=1536 scripts/design-export/export.mjs --navigation-only\n\`\`\`\n\n工具只启动独立本地Renderer与隔离浏览器，不启动Electron或runtime-host，也不修改生产源码。\n`);
const complete = pages.every((page) => page.status === 'passed' && (!navigationOnly || page.navigation?.status === 'passed'));
if (complete) {
  await writeArchive('MatchaClaw-全部页面.zip', pages);
  for (const group of new Set(pages.map((page) => page.group))) {
    await writeArchive(`MatchaClaw-${group}.zip`, pages.filter((page) => page.group === group));
  }
}
console.log(JSON.stringify({ output, exported: report.scenes.length, passed: report.scenes.filter((page) => page.status === 'passed').length, failures: report.failures, allPagesPassed: complete }, null, 2));
if (report.failures.length) process.exitCode = 1;

async function updateNavigation() {
  const previous = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const evidence = new Map(previous.pages.map((page) => [page.id, page]));
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ ...(existsSync(edge) ? { executablePath: edge } : {}), headless: true });
  for (const scene of selected) {
    const result = { ...evidence.get(scene.id) };
    const context = await browser.newContext({ viewport: result.viewport ?? report.viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    const file = join(output, `${scene.id}.html`);
    let original;
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      errors.push(`External request: ${url}`);
      return route.abort();
    });
    try {
      original = await readFile(file, 'utf8');
      const linked = addNavigation(original, scenes);
      const capture = async () => {
        await page.goto(pathToFileURL(file).href);
        await page.waitForFunction(() => window.__designSnapshotReady || window.__designSnapshotError);
        const error = await page.evaluate(() => window.__designSnapshotError);
        if (error) throw new Error(error);
        await page.locator('[data-design-tools]').evaluateAll((nodes) => nodes.forEach((node) => { node.style.display = 'none'; }));
        await page.mouse.move(0, 0);
        return page.screenshot({ animations: 'disabled' });
      };
      const before = await capture();
      await writeFile(file, linked.html, 'utf8');
      const after = await capture();
      const [a, b] = await Promise.all([before, after].map((image) => sharp(image).ensureAlpha().raw().toBuffer()));
      let changedPixels = 0;
      for (let index = 0; index < a.length; index += 4) if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) changedPixels++;
      if (changedPixels) throw new Error(`Navigation changed page appearance: ${changedPixels} pixels`);
      const targets = await page.locator('[data-design-target]').evaluateAll((nodes) => nodes.map((node) => node.dataset.designTarget));
      for (const target of targets) if (!ids.has(target) || !existsSync(join(output, `${target}.html`))) throw new Error(`Missing local navigation page: ${target}`);
      const catalog = await page.locator('#design-navigation-pages').textContent();
      if (JSON.parse(catalog).length !== scenes.length) throw new Error('Incomplete page switcher');
      await page.locator('[data-design-tools]').evaluate((node) => { node.style.removeProperty('display'); node.open = true; });
      let pickerPages = 0;
      for (const group of new Set(scenes.map((scene) => scene.group))) {
        await page.locator('[data-design-page-group]').selectOption(group);
        pickerPages += await page.locator('[data-design-page-picker] option').count();
      }
      if (pickerPages !== scenes.length) throw new Error('Page switcher does not expose every scene');
      if (errors.length) throw new Error(errors.join('; '));
      result.snapshot = { ...result.snapshot, bytes: Buffer.byteLength(linked.html), navigationCount: linked.count };
      if (result.pixelDiff?.ratio > 0.001 || !result.darkTheme) throw new Error('Source snapshot has not passed visual verification');
      result.status = 'passed';
      delete result.failure;
      result.navigation = { status: 'passed', links: linked.count, visualChangedPixels: changedPixels, verifiedAt: new Date().toISOString() };
      console.log(`PASS ${scene.id} (${linked.count} offline navigation targets, 0 visual changes)`);
    } catch (error) {
      if (original !== undefined) await writeFile(file, original, 'utf8');
      result.status = 'failed';
      result.failure = error.stack ?? String(error);
      result.navigation = { status: 'failed', error: String(error) };
      report.failures.push(scene.id);
      console.error(`FAIL ${scene.id}: ${String(error).split('\n')[0]}`);
    } finally {
      report.scenes.push(result);
      await writeFile(join(output, 'verification', 'latest-run.json'), JSON.stringify(report, null, 2));
      await context.close();
      global.gc?.();
    }
  }
}

async function writeArchive(filename, archivePages) {
  const file = await open(join(output, filename), 'w');
  let finished = false;
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error;
    writeFileSync(file.fd, chunk);
    finished = final;
  });
  const add = (name, bytes) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  };
  try {
    for (const name of ['README.md', 'PRODUCT.md', 'DESIGN.md', 'theme-tokens.css']) add(name, await readFile(join(output, name)));
    add('manifest.json', strToU8(JSON.stringify({ generatedAt: report.generatedAt, viewport: report.viewport, data: report.data, pages: archivePages }, null, 2)));
    add('index.html', strToU8(createIndex(archivePages)));
    for (const page of archivePages) add(`${page.id}.html`, strToU8(scopeNavigation(await readFile(join(output, `${page.id}.html`), 'utf8'), archivePages)));
    zip.end();
    if (!finished) throw new Error(`Archive did not finish: ${filename}`);
  } finally {
    zip.terminate();
    await file.close();
  }
}

function createIndex(pages) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MatchaClaw 全页面设计目录</title><style>:root{color-scheme:light;--bg:#f1f1f4;--card:#fff;--ink:#1d2025;--muted:#60646c;--line:#e0e1e6}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1100px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;gap:24px;align-items:center}h1{font-size:28px;letter-spacing:-.04em;margin:0}p{color:var(--muted)}input{width:100%;padding:13px 18px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:inherit;font:inherit;margin:20px 0}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}section{margin:24px 0}h2{font-size:18px;margin:0 0 8px}ul{padding:0;margin:0;list-style:none;border:1px solid var(--line);border-radius:18px;background:var(--card);overflow:hidden}li+li{border-top:1px solid var(--line)}li a{display:flex;align-items:center;gap:20px;padding:13px 18px}small{color:var(--muted);margin-left:auto}code{font-size:11px;color:var(--muted)}[hidden]{display:none!important}button{border:1px solid var(--line);background:var(--card);color:inherit;border-radius:999px;padding:9px 16px;font:inherit;cursor:pointer}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #0d74ce;outline-offset:3px}</style><main><header><div><h1>MatchaClaw 页面设计目录</h1><p>${pages.length} 个页面与状态 · 默认 1440 × 960 · 仅合成示例数据</p></div><a href="README.md">交接说明 ↗</a></header><input id="search" type="search" aria-label="搜索页面" placeholder="搜索页面、页签或源码路径">${[...new Set(pages.map((page) => page.group))].map((group) => `<section><h2>${escape(group)}</h2><ul>${pages.filter((page) => page.group === group).map((page) => `<li data-search="${escape(`${page.title} ${page.id} ${page.route} ${page.sources.join(' ')}`)}"><a href="${page.id}.html"><span>${escape(page.title)}<br><code>${escape(page.id)}</code></span><small>${escape(page.status === 'passed' ? '已验证' : page.status === 'failed' ? '验证未通过' : '尚未导出')}</small></a></li>`).join('')}</ul></section>`).join('')}</main><script>document.querySelector('#search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('li').forEach(n=>n.hidden=!n.dataset.search.toLowerCase().includes(q));document.querySelectorAll('section').forEach(n=>n.hidden=![...n.querySelectorAll('li')].some(n=>!n.hidden))})</script></html>`;
}
