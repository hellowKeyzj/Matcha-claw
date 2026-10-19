import type { SandboxChannel } from './sandbox-channel';

// Native wrapper accepts only its fixed widget-theme token vocabulary.
function widgetTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => {
    const value = style.getPropertyValue(`--${name}`).trim();
    return value ? `hsl(${value})` : '';
  };
  return {
    type: 'openclaw:widget-theme',
    mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    tokens: {
      surface: color('background'), card: color('card'), elevated: color('popover'),
      text: color('foreground'), 'text-strong': color('foreground'), muted: color('muted-foreground'),
      border: color('border'), 'border-strong': color('input'), accent: color('primary'),
      'accent-fill': color('primary'), 'accent-fg': color('primary-foreground'), danger: color('destructive'),
      radius: style.getPropertyValue('--radius').trim(), 'radius-full': style.getPropertyValue('--radius-pill').trim(),
      'scrollbar-size': style.getPropertyValue('--scrollbar-size').trim(),
      'font-body': style.getPropertyValue('--font-sans').trim(), 'font-mono': style.getPropertyValue('--font-mono').trim(),
    },
  };
}

export function bindWidgetHostState(channel: SandboxChannel, board: boolean, current: () => boolean) {
  const nonce = crypto.randomUUID();
  const post = () => {
    if (!current()) return;
    channel.post(widgetTheme());
    channel.post(board ? { type: 'openclaw:widget-board-host', nonce } : { type: 'openclaw:widget-chat-host' });
  };
  const observer = new MutationObserver(post);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  post();
  return {
    scroll: (data: Record<string, unknown>) => {
      if (!board || !current() || data.type !== 'openclaw:widget-scroll' || data.nonce !== nonce
        || typeof data.deltaY !== 'number' || !Number.isFinite(data.deltaY) || !data.deltaY) return;
      let parent = channel.frame.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if (['auto', 'scroll'].includes(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
          parent.scrollBy({ top: Math.max(-8000, Math.min(8000, data.deltaY)), behavior: 'instant' });
          return;
        }
        parent = parent.parentElement;
      }
    },
    dispose: () => observer.disconnect(),
  };
}
