import { JSDOM, VirtualConsole } from 'jsdom';
import { navigationRules as chatSettings } from './navigation-chat-settings.mjs';
import { navigationRules as workflows } from './navigation-workflows.mjs';
import { navigationRules as toolsAccount } from './navigation-tools-account.mjs';
import { navigationRules as fleetKnowledge } from './navigation-fleet-knowledge.mjs';

const rules = [...chatSettings, ...workflows, ...toolsAccount, ...fleetKnowledge];
const escape = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const entries = {
  '/': 'chat-empty', '/tasks': 'tasks-long-all', '/subagents': 'subagents-grid',
  '/teams': 'teams-list', '/providers': 'providers-overview', '/channels': 'channels-overview',
  '/wiki': 'wiki-library', '/world': 'world-data', '/world/model': 'world-model-canvas',
  '/world/changes': 'world-changes-pending', '/world/settings': 'world-settings-storage',
  '/dashboard': 'dashboard-model-7d', '/skills': 'skills-all-grid', '/plugins': 'plugins-grid',
  '/security': 'security-runtime', '/connectors': 'connectors-grid',
  '/remote-fleet': 'fleet-connections-overview', '/settings': 'settings-gateway',
  '/login': 'auth-login', '/register': 'auth-register',
  '/tasks?tab=long': 'tasks-long-all', '/tasks?tab=scheduled': 'tasks-scheduled-all',
  '/subagents?tab=agents': 'subagents-grid', '/subagents?tab=templates': 'subagents-templates-grid',
  ...Object.fromEntries(Object.entries({ gateway: 'gateway', appearance: 'appearance', browser: 'browser-relay', search: 'search-sources', updates: 'updates-idle', advanced: 'advanced', license: 'license-granted', diagnostics: 'diagnostics', calls: 'calls' })
    .map(([section, scene]) => [`/settings?section=${section}`, `settings-${scene}`])),
};

export function decorateNavigation(document, pages, sceneId) {
  const ids = new Set(pages.map((page) => page.id));
  document.querySelectorAll('[data-design-target]').forEach((element) => element.removeAttribute('data-design-target'));
  const bind = (element, target) => {
    if (!ids.has(target)) throw new Error(`Unknown navigation target: ${target}`);
    element.dataset.designTarget = target;
    if (!element.matches('a,button,input,select,textarea,option,summary')) {
      if (!element.hasAttribute('role')) element.setAttribute('role', 'link');
      if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '0');
    }
    element.removeAttribute('data-design-unmapped-link');
    if (element.localName === 'a') element.setAttribute('href', `${target}.html`);
  };
  const normalize = (value) => {
    const url = new URL(value.replace(/^#/, ''), 'http://design.invalid');
    url.searchParams.sort();
    return `${url.pathname.replace(/\/$/, '') || '/'}${url.search}`;
  };
  for (const element of document.querySelectorAll('a[href]')) {
    const href = element.getAttribute('href');
    if (/^[a-z0-9-]+\.html$/.test(href) && ids.has(href.slice(0, -5))) {
      bind(element, href.slice(0, -5));
      continue;
    }
    if (!href.startsWith('#/') && !href.startsWith('/')) continue;
    const route = normalize(href);
    const url = new URL(route, 'http://design.invalid');
    const exact = pages.find((page) => normalize(page.route) === route);
    const target = entries[route] ?? (url.search ? exact?.id : entries[url.pathname] ?? exact?.id);
    if (target) bind(element, target);
  }
  const sidebar = {
    '新对话': 'chat-empty', '任务中心': 'tasks-long-all', Agent: 'subagents-grid',
    '团队': 'teams-list', '模型': 'providers-overview', '频道': 'channels-overview',
    Wiki: 'wiki-library', '仪表盘': 'dashboard-model-7d',
    '业务数据': 'world-data', '模型与规则': 'world-model-canvas',
    '变更审核': 'world-changes-pending', '世界设置': 'world-settings-storage',
  };
  if (/^(channels|skills|plugins|connectors)-native-/.test(sceneId)) {
    const nativeEntries = { 'channels-overview': 'channels-native-overview', 'skills-all-grid': 'skills-native-overview', 'plugins-grid': 'plugins-native-grid', 'connectors-grid': 'connectors-native-overview' };
    for (const element of document.querySelectorAll('main a[data-design-target]')) {
      const target = nativeEntries[element.dataset.designTarget];
      if (target) bind(element, target);
    }
  }
  const text = (element) => element.textContent.trim().replace(/\s+/g, ' ');
  for (const element of document.querySelectorAll('aside nav a,aside nav button')) {
    const target = sidebar[text(element)];
    if (target) bind(element, target);
  }
  for (const element of document.querySelectorAll('button[title="设置"]')) {
    if (!element.closest('main')) bind(element, 'settings-gateway');
  }
  const world = document.querySelector('button[aria-controls="sidebar-world-pages"]');
  if (world) {
    world.dataset.designDisclosure = 'sidebar-world-pages';
    const panel = document.getElementById('sidebar-world-pages');
    if (panel && world.getAttribute('aria-expanded') !== 'true') panel.hidden = true;
  }
  for (const rule of rules) {
    if (![rule.from].flat().some((prefix) => sceneId.startsWith(prefix))) continue;
    let elements = [...document.querySelectorAll(rule.selector)];
    if (rule.text !== undefined) elements = elements.filter((element) => text(element) === rule.text);
    if (rule.index !== undefined) elements = elements.slice(rule.index, rule.index + 1);
    for (const element of elements) bind(element, rule.target);
  }
  return document.querySelectorAll('[data-design-target]').length;
}

function activateNavigation() {
  const pages = JSON.parse(document.querySelector('#design-navigation-pages').textContent);
  const available = new Set(pages.map((page) => page.id));
  for (const element of document.querySelectorAll('[data-design-target]')) {
    if (available.has(element.dataset.designTarget)) continue;
    element.dataset.designUnavailable = '';
    element.title = '当前分组不包含此页面，请使用完整包';
    if (element.localName === 'a') element.setAttribute('href', '#');
  }
  document.addEventListener('click', (event) => {
    const disclosure = event.target.closest('[data-design-disclosure]');
    if (disclosure) {
      const panel = document.getElementById(disclosure.dataset.designDisclosure);
      if (panel) {
        const expanded = disclosure.getAttribute('aria-expanded') !== 'true';
        disclosure.setAttribute('aria-expanded', String(expanded));
        panel.hidden = !expanded;
      }
      return;
    }
    const target = event.target.closest('[data-design-target]');
    if (!target) return;
    event.preventDefault();
    if (!available.has(target.dataset.designTarget) || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    location.href = `${target.dataset.designTarget}.html`;
  });
  document.addEventListener('change', (event) => {
    if (event.target.localName !== 'select') return;
    const option = event.target.selectedOptions[0];
    if (!event.target.disabled && option?.dataset.designTarget && !option.disabled && available.has(option.dataset.designTarget)) location.href = `${option.dataset.designTarget}.html`;
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target.closest('[data-design-target]');
    if (!target || target.matches('button,a,input,select,textarea') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    target.click();
  });
  const group = document.querySelector('[data-design-page-group]');
  const picker = document.querySelector('[data-design-page-picker]');
  const current = JSON.parse(document.querySelector('#design-snapshot-metadata').textContent);
  for (const name of new Set(pages.map((page) => page.group))) group.add(new Option(name, name));
  const fillPages = () => {
    picker.replaceChildren();
    for (const page of pages.filter((page) => page.group === group.value)) picker.add(new Option(page.title, page.id));
    if (available.has(current.id) && current.group === group.value) picker.value = current.id;
  };
  group.value = current.group;
  fillPages();
  group.addEventListener('change', fillPages);
  document.querySelector('[data-design-page-open]').addEventListener('click', () => {
    if (available.has(picker.value)) location.href = `${picker.value}.html`;
  });
}

export function addNavigation(html, pages) {
  const styles = [];
  const markup = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, start, css, end) => {
    styles.push(css);
    return `${start}/* design-css-${styles.length - 1} */${end}`;
  });
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => { if (error.type !== 'css-parsing') throw error; });
  const dom = new JSDOM(markup, { virtualConsole: console });
  try {
    const document = dom.window.document;
    const metadata = JSON.parse(document.querySelector('#design-snapshot-metadata').textContent);
    document.querySelectorAll('[data-design-navigation],#design-navigation-pages,#design-navigation-style').forEach((node) => node.remove());
    const count = decorateNavigation(document, pages, metadata.id);
    const style = document.createElement('style');
    style.id = 'design-navigation-style';
    style.textContent = '[data-design-target]:not(:disabled){cursor:pointer}[data-design-tools] select{width:100%;min-width:0;border:1px solid hsl(var(--border));border-radius:6px;padding:4px;color:inherit;background:hsl(var(--popover))}[data-design-tools] [data-design-page-open]{width:100%}';
    document.head.append(style);
    const tools = document.querySelector('[data-design-tools]>div');
    const controls = document.createElement('div');
    controls.dataset.designNavigation = '';
    controls.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%';
    controls.innerHTML = '<select data-design-page-group aria-label="页面分组"></select><select data-design-page-picker aria-label="选择页面或页签"></select><button type="button" data-design-page-open>打开所选页面</button>';
    tools.append(controls);
    const data = document.createElement('script');
    data.type = 'application/json';
    data.id = 'design-navigation-pages';
    data.textContent = escape(pages.map(({ id, title, group }) => ({ id, title, group })));
    const script = document.createElement('script');
    script.dataset.designNavigation = '';
    script.textContent = `(${activateNavigation.toString()})();`;
    document.body.append(data, script);
    return { html: dom.serialize().replace(/\/\* design-css-(\d+) \*\//g, (_, index) => styles[Number(index)]), count };
  } finally {
    dom.window.close();
  }
}

export function scopeNavigation(html, pages) {
  return html.replace(/(<script type="application\/json" id="design-navigation-pages">)[\s\S]*?(<\/script>)/,
    (_, start, end) => start + escape(pages.map(({ id, title, group }) => ({ id, title, group }))) + end);
}
