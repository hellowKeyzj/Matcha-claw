const CODE_COPY_FEEDBACK_MS = 1600;

interface MarkdownCodeCopyEvent {
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

const codeCopyTimers = new WeakMap<HTMLButtonElement, number>();

function getEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

function setCodeCopyState(button: HTMLButtonElement, copied: boolean): void {
  if (copied) {
    button.dataset.copied = 'true';
  } else {
    delete button.dataset.copied;
  }
  button.querySelector<HTMLElement>('.chat-code-copy-default')?.toggleAttribute('hidden', copied);
  button.querySelector<HTMLElement>('.chat-code-copy-done')?.toggleAttribute('hidden', !copied);
}

function showCodeCopyFeedback(button: HTMLButtonElement): void {
  const previousTimer = codeCopyTimers.get(button);
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
  }

  setCodeCopyState(button, true);
  codeCopyTimers.set(button, window.setTimeout(() => {
    setCodeCopyState(button, false);
    codeCopyTimers.delete(button);
  }, CODE_COPY_FEEDBACK_MS));
}

export function handleMarkdownCodeBlockCopy(event: MarkdownCodeCopyEvent): boolean {
  const target = getEventElement(event.target);
  const button = target?.closest('[data-chat-code-copy]');
  if (!(button instanceof HTMLButtonElement)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const block = button.closest('[data-chat-code-block]');
  const code = block?.querySelector('pre code');
  const codeText = code?.textContent ?? '';
  if (!codeText) {
    return true;
  }

  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    return true;
  }

  void clipboard.writeText(codeText).then(() => {
    showCodeCopyFeedback(button);
  }).catch(() => undefined);

  return true;
}
