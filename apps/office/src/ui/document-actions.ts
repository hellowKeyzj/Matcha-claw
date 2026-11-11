import { appApi } from '../documents/client';
import './dialogs.css';

const labels = {
  en: { unsaved: 'Save changes before continuing?', save: 'Save changes', discard: 'Discard changes', cancel: 'Cancel', name: 'Save a copy', filename: 'File name', create: 'Save copy' },
  zh: { unsaved: '继续前保存修改？', save: '保存修改', discard: '放弃修改', cancel: '取消', name: '保存副本', filename: '文件名', create: '保存副本' },
  ja: { unsaved: '続行する前に変更を保存しますか？', save: '変更を保存', discard: '変更を破棄', cancel: 'キャンセル', name: 'コピーを保存', filename: 'ファイル名', create: 'コピーを保存' },
  ru: { unsaved: 'Сохранить изменения перед продолжением?', save: 'Сохранить изменения', discard: 'Не сохранять', cancel: 'Отмена', name: 'Сохранить копию', filename: 'Имя файла', create: 'Сохранить копию' },
  ko: { unsaved: '계속하기 전에 변경 사항을 저장할까요?', save: '변경 사항 저장', discard: '변경 사항 버리기', cancel: '취소', name: '사본 저장', filename: '파일 이름', create: '사본 저장' }
};

function text() {
  const language = appApi().context.language?.split('-')[0] ?? 'en';
  return labels[language as keyof typeof labels] ?? labels.en;
}

function showDialog<T>(title: string, cancelled: T, content: (dialog: HTMLDialogElement, finish: (value: T) => void) => void, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.resolve(cancelled);
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'matcha-library-dialog';
  const heading = document.createElement('h2');
  heading.id = `office-dialog-${crypto.randomUUID()}`;
  heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading);
  return new Promise((resolve) => {
    let result = cancelled;
    content(dialog, (value) => { result = value; dialog.close(); });
    const abort = () => dialog.close();
    signal?.addEventListener('abort', abort, { once: true });
    dialog.addEventListener('close', () => {
      signal?.removeEventListener('abort', abort);
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function addButton(dialog: HTMLDialogElement, label: string, action: () => void): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = action;
  dialog.append(button);
}

export function chooseUnsavedAction(signal?: AbortSignal): Promise<'save' | 'discard' | 'cancel'> {
  const labels = text();
  return showDialog<'save' | 'discard' | 'cancel'>(labels.unsaved, 'cancel', (dialog, finish) => {
    addButton(dialog, labels.save, () => finish('save'));
    addButton(dialog, labels.discard, () => finish('discard'));
    addButton(dialog, labels.cancel, () => finish('cancel'));
  }, signal);
}

export function chooseAction<T extends string>(options: {
  title: string;
  message?: string;
  actions: readonly { value: T; label: string }[];
  cancel?: boolean;
}, signal?: AbortSignal): Promise<T | null> {
  return showDialog<T | null>(options.title, null, (dialog, finish) => {
    if (options.message) {
      const message = document.createElement('p');
      message.textContent = options.message;
      dialog.append(message);
    }
    for (const action of options.actions) addButton(dialog, action.label, () => finish(action.value));
    if (options.cancel !== false) addButton(dialog, text().cancel, () => finish(null));
  }, signal);
}

export function chooseDocumentName(defaultName: string): Promise<string | null> {
  const labels = text();
  return showDialog<string | null>(labels.name, null, (dialog, finish) => {
    const form = document.createElement('form');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.value = defaultName;
    input.required = true;
    input.maxLength = 200;
    input.autofocus = true;
    label.append(document.createTextNode(labels.filename), input);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = labels.create;
    form.append(label, submit);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (input.value.trim()) finish(input.value.trim());
    };
    dialog.append(form);
    addButton(dialog, labels.cancel, () => finish(null));
  });
}
