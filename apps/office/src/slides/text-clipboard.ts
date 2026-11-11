import type { AppWebviewApi } from '@matcha/app-plugins-sdk';

const tags = new Set(['P', 'DIV', 'SPAN', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'FONT']);
const drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'IMG', 'VIDEO', 'AUDIO', 'LINK', 'META', 'BASE']);
const styles = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align', 'vertical-align', 'line-height', 'letter-spacing', 'white-space', 'margin-left', 'padding-left'];

/** Retain text formatting without importing active content or external resources. */
function textHtml(source: string): string {
  const parsed = document.createElement('template');
  parsed.innerHTML = source;
  const clean = (parent: ParentNode) => {
    for (const child of [...parent.children]) {
      if (drop.has(child.tagName)) { child.remove(); continue; }
      clean(child);
      if (!tags.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
      const original = child as HTMLElement;
      const retained = styles.map(name => [name, original.style.getPropertyValue(name)] as const);
      const href = child.tagName === 'A' ? child.getAttribute('href') : null;
      const face = child.tagName === 'FONT' ? child.getAttribute('face') : null;
      const color = child.tagName === 'FONT' ? child.getAttribute('color') : null;
      const size = child.tagName === 'FONT' ? child.getAttribute('size') : null;
      for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name);
      for (const [name, value] of retained) if (value && !/url\s*\(|expression\s*\(|@import/i.test(value)) original.style.setProperty(name, value);
      if (href && /^(https?:|mailto:|tel:|#|slide:\d+$|action:\w+$)/i.test(href.trim())) child.setAttribute('href', href);
      if (face) child.setAttribute('face', face);
      if (color) child.setAttribute('color', color);
      if (size && /^[1-7]$/.test(size)) child.setAttribute('size', size);
    }
  };
  clean(parsed.content);
  return parsed.innerHTML;
}

export async function textClipboard(api: AppWebviewApi, operation: 'cut' | 'copy' | 'paste'): Promise<void> {
  const active = document.activeElement;
  const field = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart !== null ? active : null;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const start = field?.selectionStart ?? 0;
  const end = field?.selectionEnd ?? start;
  if (operation !== 'paste') {
    if (field) {
      if (start === end) return;
      await api.writeClipboard({ text: field.value.slice(start, end) });
      if (operation === 'cut' && field.isConnected && !field.readOnly && !field.disabled) { field.setRangeText('', start, end, 'end'); field.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (range && !range.collapsed) {
      const container = document.createElement('div');
      const wrapper = document.createElement('span');
      const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      if (ancestor) {
        const computed = getComputedStyle(ancestor);
        for (const name of styles) wrapper.style.setProperty(name, computed.getPropertyValue(name));
      }
      wrapper.append(range.cloneContents());
      container.append(wrapper);
      await api.writeClipboard({ text: range.toString(), html: textHtml(container.innerHTML) });
      if (operation === 'cut' && active instanceof HTMLElement && active.isConnected && active.isContentEditable && active.contains(range.commonAncestorContainer)) {
        active.focus();
        selection?.removeAllRanges(); selection?.addRange(range);
        document.execCommand('delete');
      }
    }
    return;
  }
  const content = await api.readClipboard();
  if (field && field.isConnected && !field.readOnly && !field.disabled && content.text !== undefined) {
    field.focus();
    field.setRangeText(content.text, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (range && active instanceof HTMLElement && active.isConnected && active.isContentEditable && active.contains(range.commonAncestorContainer)) {
    active.focus(); selection?.removeAllRanges(); selection?.addRange(range);
    if (content.html) document.execCommand('insertHTML', false, textHtml(content.html));
    else if (content.text) document.execCommand('insertText', false, content.text);
  }
}
