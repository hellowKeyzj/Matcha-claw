import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { addNavigation } from './navigation.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

function assertLocalAsset(value) {
  const url = new URL(value);
  const origin = url.protocol === 'blob:' ? new URL(url.pathname) : url;
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
    || origin.username || origin.password) {
    throw new Error(`拒绝导出非本地资产：${url.origin}${url.pathname}`);
  }
  return url;
}

function captureSnapshot() {
  const assetUrls = [];
  const stylesheetUrls = [];
  const assetIndices = new Map();
  const assetPrefix = `__design_asset_${Math.random().toString(36).slice(2)}_`;
  const baseUrl = document.baseURI;
  const originals = [document.body, ...document.body.querySelectorAll('*')];
  const body = document.body.cloneNode(true);
  const copies = [body, ...body.querySelectorAll('*')];
  const root = document.documentElement.cloneNode(false);
  const fontFamilies = new Set();
  let focusedOutline = '';
  let canvasCount = 0;

  const rememberAsset = (value, base = baseUrl) => {
    if (!value || /^(data:|#)/i.test(value.trim())) return value;
    const url = new URL(value, base).href;
    if (!assetIndices.has(url)) {
      assetIndices.set(url, assetUrls.length);
      assetUrls.push(url);
    }
    return `${assetPrefix}${assetIndices.get(url)}__`;
  };
  const decodeCssUrl = (value) => value.replace(/\\([\da-f]{1,6}\s?|\r\n|[\s\S])/gi, (_, escaped) => {
    if (/^[\da-f]/i.test(escaped)) {
      const codePoint = parseInt(escaped.trim(), 16);
      return String.fromCodePoint(codePoint > 0 && codePoint <= 0x10ffff ? codePoint : 0xfffd);
    }
    return /^[\r\n\f]/.test(escaped) ? '' : escaped;
  });
  // CSS 字符串和注释不能被当作 url()；data URL 与 SVG fragment 保持原样。
  const markCssAssets = (css, base = baseUrl) => css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^)\\])*?))\s*\)/gi,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted;
      if (value === undefined) return match;
      const decoded = decodeCssUrl(value.trim());
      if (!decoded || /^(data:|#)/i.test(decoded)) return match;
      return `url("${rememberAsset(decoded, base)}")`;
    },
  );
  const collectFonts = (style) => {
    for (const family of style.fontFamily.split(',')) {
      fontFamilies.add(family.trim().replace(/^["']|["']$/g, '').toLowerCase());
    }
  };
  for (const element of originals) {
    collectFonts(getComputedStyle(element));
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      if (style.content !== 'none' && style.content !== 'normal') collectFonts(style);
    }
  }

  const serializeRules = (rules, base) => Array.from(rules, (rule) => {
    if (rule.type === CSSRule.IMPORT_RULE) {
      stylesheetUrls.push(new URL(rule.href, base).href);
      if (!rule.styleSheet) throw new Error(`无法读取导入样式：${rule.href}`);
      let css = serializeRules(rule.styleSheet.cssRules, rule.href);
      if (rule.media.mediaText) css = `@media ${rule.media.mediaText}{${css}}`;
      if (rule.supportsText) css = `@supports (${rule.supportsText}){${css}}`;
      if (rule.layerName !== null && rule.layerName !== undefined) css = `@layer ${rule.layerName}{${css}}`;
      return css;
    }
    if (rule.type === CSSRule.FONT_FACE_RULE) {
      const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!fontFamilies.has(family)) return '';
    }
    if (rule instanceof CSSGroupingRule) {
      return `${rule.cssText.slice(0, rule.cssText.indexOf('{') + 1)}${serializeRules(rule.cssRules, base)}}`;
    }
    let css = rule.cssText;
    if (rule.selectorText) {
      const selector = rule.selectorText.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|:focus-visible\b/g, (token) => (
        token === ':focus-visible' ? ':is(:focus-visible:where(:not([data-design-focused])),[data-design-focus-visible])' : token
      ));
      css = selector + css.slice(rule.selectorText.length);
    }
    return markCssAssets(css, base);
  }).join('\n');
  const styles = [...document.styleSheets, ...document.adoptedStyleSheets].map((sheet) => {
    if (sheet.href) stylesheetUrls.push(sheet.href);
    let css;
    try {
      css = serializeRules(sheet.cssRules, sheet.href || baseUrl);
    } catch (error) {
      throw new Error(`无法完整读取样式 ${sheet.href || sheet.ownerNode?.getAttribute('data-vite-dev-id') || 'inline'}：${error.message}`);
    }
    if (sheet.media?.mediaText) css = `@media ${sheet.media.mediaText}{${css}}`;
    return sheet.disabled ? `@media not all{${css}}` : css;
  }).join('\n');

  const rewriteLink = (element, attribute, value) => {
    const url = new URL(value, baseUrl);
    if (value.startsWith('#') && !/^#\/?[!/]?\//.test(value)
      && document.getElementById(value.slice(1))) return;
    const isLocal = url.origin === location.origin;
    element.setAttribute(attribute, isLocal ? (url.hash.startsWith('#/') ? url.hash : `#${url.pathname}${url.search}`) : '#');
    element.setAttribute('data-design-unmapped-link', '');
    element.removeAttribute('target');
    element.removeAttribute('download');
  };
  const cleanAttributes = (element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['nonce', 'integrity', 'crossorigin', 'ping', 'attributionsrc', 'autofocus', 'formaction'].includes(name)) {
        element.removeAttributeNode(attribute);
      } else if (name === 'style' || ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor'].includes(name)) {
        element.setAttribute(attribute.name, markCssAssets(attribute.value));
      }
    }
  };
  cleanAttributes(root);
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index];
    const copy = copies[index];
    const tag = original.localName.toLowerCase();
    cleanAttributes(copy);
    if (original.matches(':popover-open')) {
      copy.setAttribute('data-design-popover-open', '');
      const source = document.querySelector(`[popovertarget="${CSS.escape(original.id)}"]`);
      if (source) source.id ? copy.dataset.designPopoverSource = source.id : copies[originals.indexOf(source)].setAttribute('data-design-popover-source', original.id);
    }
    if (original === document.activeElement && original !== document.body) {
      copy.setAttribute('data-design-focused', '');
      // UA 的 :focus-visible 不在 document.styleSheets 内，初始 outline 必须保存实际 computed 值。
      const style = getComputedStyle(original);
      focusedOutline = `[data-design-focused]{${['outline-style', 'outline-color', 'outline-width', 'outline-offset'].map((property) => `${property}:${style.getPropertyValue(property)}!important`).join(';')}}`;
      if (original.matches(':focus-visible')) copy.setAttribute('data-design-focus-visible', '');
      if (typeof original.selectionStart === 'number') {
        copy.dataset.designSelection = JSON.stringify([original.selectionStart, original.selectionEnd, original.selectionDirection]);
      }
    }
    if (original.scrollTop || original.scrollLeft) {
      copy.dataset.designScroll = JSON.stringify([original.scrollLeft, original.scrollTop]);
    }
    if (tag === 'input') {
      copy.setAttribute('value', original.value);
      copy.toggleAttribute('checked', original.checked);
      if (original.indeterminate) copy.setAttribute('data-design-indeterminate', '');
    }
    if (tag === 'textarea') copy.textContent = original.value;
    if (tag === 'option') copy.toggleAttribute('selected', original.selected);
    if (tag === 'img') {
      const src = original.currentSrc || original.getAttribute('src');
      if (src) copy.setAttribute('src', rememberAsset(src));
      copy.removeAttribute('srcset');
      copy.removeAttribute('sizes');
      copy.setAttribute('loading', 'eager');
    }
    if (tag === 'source' && original.parentElement?.localName === 'picture') copy.remove();
    if (['image', 'use', 'feimage'].includes(tag)) {
      for (const attribute of ['href', 'xlink:href']) {
        if (original.hasAttribute(attribute)) copy.setAttribute(attribute, rememberAsset(original.getAttribute(attribute)));
      }
    }
    if (['video', 'audio', 'source', 'track', 'input'].includes(tag) && original.hasAttribute('src')) {
      copy.setAttribute('src', rememberAsset(original.getAttribute('src')));
    }
    if (original.hasAttribute('poster')) copy.setAttribute('poster', rememberAsset(original.getAttribute('poster')));
    if (original.hasAttribute('background')) copy.setAttribute('background', rememberAsset(original.getAttribute('background')));
    if (tag === 'a' || tag === 'area') {
      for (const attribute of ['href', 'xlink:href']) {
        if (original.hasAttribute(attribute)) rewriteLink(copy, attribute, original.getAttribute(attribute));
      }
    }
    if (tag === 'form') {
      copy.removeAttribute('action');
      copy.removeAttribute('target');
    }
    if (['iframe', 'object', 'embed'].includes(tag)) {
      if (original.getClientRects().length) throw new Error(`无法静态保真导出活动内嵌文档：${tag}`);
      copy.remove();
    }
    if (tag === 'canvas' && original.width && original.height) {
      const image = document.createElement('img');
      for (const attribute of copy.attributes) image.setAttribute(attribute.name, attribute.value);
      try {
        image.src = original.toDataURL('image/png');
      } catch (error) {
        throw new Error(`无法导出 canvas 像素素材 #${canvasCount + 1}：${error.message}`);
      }
      const style = getComputedStyle(original);
      for (const property of ['display', 'width', 'height', 'max-width', 'max-height', 'box-sizing', 'vertical-align']) {
        image.style.setProperty(property, style.getPropertyValue(property));
      }
      image.setAttribute('data-design-pixel-material', 'canvas');
      image.setAttribute('alt', original.getAttribute('aria-label') || 'Canvas 像素素材（仅此局部为位图）');
      copy.replaceWith(image);
      canvasCount += 1;
    }
  }

  // HTML 重解析会合并相邻 Text，改变字距；注释保留 React 的原始文字 run 边界。
  for (let index = 0; index < originals.length; index += 1) {
    const nodes = [...originals[index].childNodes];
    const cloned = [...copies[index].childNodes];
    nodes.forEach((node, position) => {
      if (node.nodeType === Node.TEXT_NODE && nodes[position + 1]?.nodeType === Node.TEXT_NODE
        && cloned[position + 1]?.nodeType === Node.TEXT_NODE) {
        copies[index].insertBefore(document.createComment('design-text-boundary'), cloned[position + 1]);
      }
    });
  }

  // 只冻结原页上正在影响呈现的动画属性，不修改原页的动画或 React 状态。
  for (const animation of document.getAnimations()) {
    const effect = animation.effect;
    const index = originals.indexOf(effect?.target);
    if (index < 0 || effect.pseudoElement) continue;
    const style = getComputedStyle(effect.target);
    for (const frame of effect.getKeyframes()) {
      for (const property of Object.keys(frame)) {
        if (['offset', 'computedOffset', 'easing', 'composite'].includes(property)) continue;
        const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        copies[index].style.setProperty(cssProperty, markCssAssets(style.getPropertyValue(cssProperty)));
      }
    }
  }
  body.querySelectorAll('script,style,link,base,meta,template,noscript,vite-error-overlay,vite-plugin-checker-error-overlay,vite-dev-tools,[data-design-tools]').forEach((element) => element.remove());
  if (getComputedStyle(document.body).pointerEvents === 'none') body.style.setProperty('pointer-events', 'auto', 'important');
  if (body.hasAttribute('data-scroll-locked')) {
    // 保留 Radix 的 margin/padding/position 补偿和 portal，只解除输入/滚动拦截。
    body.style.setProperty('overflow', 'auto', 'important');
    body.style.setProperty('overscroll-behavior', 'auto', 'important');
  }
  root.setAttribute('data-design-snapshot', '');
  return {
    htmlAttributes: [...root.attributes].map(({ name, value }) => [name, value]),
    body: body.outerHTML,
    styles: styles + focusedOutline,
    assetUrls,
    stylesheetUrls,
    assetPrefix,
    canvasCount,
    scroll: [window.scrollX, window.scrollY],
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
  };
}

async function restoreSnapshot(scroll, compressedAssets) {
  for (const { token, gzip } of compressedAssets) {
    const bytes = Uint8Array.from(atob(gzip), (character) => character.charCodeAt(0));
    const decompressed = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(decompressed)}`;
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        if (attribute.value.includes(token)) element.setAttribute(attribute.name, attribute.value.replaceAll(token, url));
      }
    }
    for (const style of document.querySelectorAll('style')) style.textContent = style.textContent.replaceAll(token, url);
  }
  document.querySelectorAll('[data-design-popover-open]').forEach((element) => {
    const source = element.dataset.designPopoverSource
      ? document.getElementById(element.dataset.designPopoverSource)
      : document.querySelector(`[data-design-popover-source="${CSS.escape(element.id)}"]`);
    element.showPopover(source ? { source } : undefined);
  });
  const restoreScroll = () => {
    document.querySelectorAll('[data-design-scroll]').forEach((element) => {
      const [left, top] = JSON.parse(element.dataset.designScroll);
      element.scrollTo({ left, top, behavior: 'instant' });
    });
    window.scrollTo({ left: scroll[0], top: scroll[1], behavior: 'instant' });
  };
  document.querySelectorAll('[data-design-indeterminate]').forEach((element) => { element.indeterminate = true; });
  const focused = document.querySelector('[data-design-focused]');
  focused?.focus({ preventScroll: true });
  focused?.addEventListener('blur', () => {
    focused.removeAttribute('data-design-focused');
    focused.removeAttribute('data-design-focus-visible');
  }, { once: true });
  if (focused?.dataset.designSelection) focused.setSelectionRange(...JSON.parse(focused.dataset.designSelection));
  restoreScroll();
  window.addEventListener('load', restoreScroll, { once: true });
  document.fonts.ready.then(restoreScroll);
  document.addEventListener('submit', (event) => event.preventDefault());
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-design-unmapped-link]')) event.preventDefault();
  });
  document.querySelector('[data-design-theme-toggle]').addEventListener('click', () => {
    const root = document.documentElement;
    const theme = root.classList.contains('dark') ? 'light' : 'dark';
    for (const element of [root, document.body]) {
      element.classList.remove('light', 'dark');
      if (element === root) element.classList.add(theme);
      if (element.hasAttribute('data-theme')) element.setAttribute('data-theme', theme);
      if (element.hasAttribute('data-theme-surface')) element.setAttribute('data-theme-surface', theme);
    }
    root.style.colorScheme = theme;
  });
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  restoreScroll();
  window.__designSnapshotReady = true;
}

const snapshotStyles = `
[data-design-snapshot] *,[data-design-snapshot] *::before,[data-design-snapshot] *::after{animation:none!important;transition:none!important}
[data-design-tools]{position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:auto;font:12px/1.5 var(--font-sans,system-ui);color:hsl(var(--popover-foreground,220 12% 13%));background:hsl(var(--popover,0 0% 100%));border:1px solid hsl(var(--border,225 12% 89%));border-radius:var(--radius-interactive,12px);box-shadow:var(--shadow-elevated,0 4px 16px #0002);max-width:220px}
[data-design-tools] summary{padding:5px 10px;cursor:pointer;list-style:none;user-select:none}
[data-design-tools] summary::-webkit-details-marker{display:none}
[data-design-tools]>div{display:flex;flex-wrap:wrap;gap:6px;padding:0 8px 8px}
[data-design-tools] a,[data-design-tools] button{appearance:none;display:inline-block;padding:4px 8px;border:1px solid hsl(var(--border,225 12% 89%));border-radius:8px;background:hsl(var(--secondary,220 18% 96%));color:inherit;font:inherit;text-decoration:none;cursor:pointer}
[data-design-tools] a:focus-visible,[data-design-tools] button:focus-visible,[data-design-tools] summary:focus-visible{outline:2px solid hsl(var(--ring,208 88% 43%));outline-offset:2px}
[data-design-tools] small{flex-basis:100%;color:hsl(var(--muted-foreground,220 6% 40%))}
[data-design-tools][hidden]{display:none!important}
@media(prefers-reduced-motion:reduce){[data-design-tools],[data-design-tools] *{animation:none!important;transition:none!important}}
`;

export async function exportSnapshot(page, { id, title, group, route, sources, outputFile, pages }) {
  await page.evaluate(async () => {
    const editors = [...document.querySelectorAll('.monaco-diff-editor')].filter((element) => element.getClientRects().length);
    if (!editors.length) return;
    const moduleUrl = new URL('/src/lib/monaco/loader.ts', location.href);
    if (moduleUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(moduleUrl.hostname)) {
      throw new Error('拒绝从非本地 Renderer 读取 Monaco 状态');
    }
    const { monaco } = await import(moduleUrl.href);
    await Promise.all(monaco.editor.getDiffEditors().filter((editor) => editor.getContainerDomNode().getClientRects().length).map((editor) => {
      if (editor.getLineChanges() !== null) return;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { listener.dispose(); reject(new Error('Monaco diff 在 15 秒内未完成')); }, 15000);
        const listener = editor.onDidUpdateDiff(() => {
          if (editor.getLineChanges() === null) return;
          clearTimeout(timeout);
          listener.dispose();
          resolve();
        });
      });
    }));
    // 原生 diff 完成后再等绘制 DOM 收敛；没有差异的空数组同样是完成状态。
    let lastMutation = performance.now();
    const observer = new MutationObserver(() => { lastMutation = performance.now(); });
    editors.forEach((element) => observer.observe(element, { childList: true, subtree: true, attributes: true, characterData: true }));
    const deadline = performance.now() + 5000;
    try {
      while (performance.now() - lastMutation < 600) {
        if (performance.now() >= deadline) throw new Error('Monaco diff 在 5 秒内未稳定，未生成不一致快照');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } finally {
      observer.disconnect();
    }
  });
  const snapshot = await page.evaluate(captureSnapshot);
  // 在发起任何读取之前检查所有引用；尤其不能让 APIRequestContext 自动跟随外网重定向。
  [...snapshot.stylesheetUrls, ...snapshot.assetUrls].forEach(assertLocalAsset);
  const assets = new Map();
  const compressedAssets = [];
  let html = snapshot.body;
  let styles = snapshot.styles;
  for (let index = 0; index < snapshot.assetUrls.length; index += 1) {
    const url = assertLocalAsset(snapshot.assetUrls[index]);
    const fragment = url.hash;
    url.hash = '';
    const key = url.href;
    if (!assets.has(key)) {
      let dataUrl;
      if (url.protocol === 'blob:') {
        dataUrl = await page.evaluate(async (value) => {
          const blob = await (await fetch(value)).blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }, key);
      } else {
        const response = await page.request.get(key, { maxRedirects: 0, timeout: 15000 });
        try {
          if (!response.ok()) throw new Error(`本地资产读取失败 (${response.status()})：${url.pathname}`);
          const contentType = response.headers()['content-type']?.split(';')[0] || 'application/octet-stream';
          if (/^(text\/html|application\/json)$/i.test(contentType)) throw new Error(`资产返回了非静态内容 ${contentType}：${url.pathname}`);
          const bytes = await response.body();
          // 仅压缩已实测占大头的 logo，离线解压原始 SVG，避免栅格化改变 crispEdges 缩放。
          if (url.pathname === '/src/assets/logo.svg' && contentType === 'image/svg+xml') {
            dataUrl = `data:image/svg+xml,design-compressed-${compressedAssets.length}`;
            compressedAssets.push({ token: dataUrl, gzip: gzipSync(bytes, { level: 9 }).toString('base64') });
          } else {
            dataUrl = `data:${contentType};base64,${bytes.toString('base64')}`;
          }
        } finally {
          await response.dispose();
        }
      }
      assets.set(key, dataUrl);
    }
    const marker = `${snapshot.assetPrefix}${index}__`;
    const dataUrl = assets.get(key) + fragment;
    html = html.replaceAll(marker, dataUrl);
    styles = styles.replaceAll(marker, dataUrl);
  }
  const metadata = { id, title, group, route, sources, viewport: snapshot.viewport, canvasCount: snapshot.canvasCount,
    compressedAssets: compressedAssets.map(() => ({ source: 'src/assets/logo.svg', encoding: 'gzip+base64', material: 'svg' })),
  };
  const tools = `<details data-design-tools><summary aria-label="展开设计快照工具">设计</summary><div><a href="index.html">返回目录</a><button type="button" data-design-theme-toggle>浅 / 深色</button><small>独立静态 DOM · 合成场景${snapshot.canvasCount ? ` · ${snapshot.canvasCount} 处 canvas 为像素素材` : ''}</small></div></details>`;
  const attributes = snapshot.htmlAttributes.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  const csp = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
  const head = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>${escapeHtml(title)}</title><script type="application/json" id="design-snapshot-metadata">${scriptJson(metadata)}</script><style>${(styles + snapshotStyles).replace(/<\/style/gi, '<\\/style')}</style></head>`;
  html = `<!DOCTYPE html>\n<html${attributes}>${head}${html.replace(/<\/body>$/i, `${tools}<script>window.__designSnapshotReady=false;(${restoreSnapshot.toString()})(${scriptJson(snapshot.scroll)},${scriptJson(compressedAssets)}).catch(error=>{window.__designSnapshotError=error.message;console.error(error)});</script></body>`)}</html>\n`;
  const linked = addNavigation(html, pages || []);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, linked.html, 'utf8');
  return { bytes: Buffer.byteLength(linked.html), assetCount: assets.size, canvasCount: snapshot.canvasCount, navigationCount: linked.count };
}
