import type { AppWebviewApi } from '@matcha/app-plugins-sdk';

const api: AppWebviewApi | undefined = window.matchaApp;
const messages = {
  en: { text: 'Text', submit: 'Echo', unavailable: 'Open this plugin in Matcha to call its backend.', failed: 'The tool call failed.' },
  zh: { text: '文本', submit: '回显', unavailable: '请在 Matcha 中打开插件以调用后台。', failed: '工具调用失败。' },
  ja: { text: 'テキスト', submit: 'エコー', unavailable: 'バックエンドを呼び出すには Matcha で開いてください。', failed: 'ツールの呼び出しに失敗しました。' },
  ru: { text: 'Текст', submit: 'Повторить', unavailable: 'Откройте плагин в Matcha для вызова инструмента.', failed: 'Не удалось вызвать инструмент.' },
};
let language: keyof typeof messages = 'en';
const form = document.querySelector<HTMLFormElement>('#echo')!;
const input = document.querySelector<HTMLInputElement>('#text')!;
const result = document.querySelector<HTMLElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#submit')!;
function localize(value = 'en') {
  const key = value.split('-')[0];
  language = key in messages ? key as keyof typeof messages : 'en';
  document.documentElement.lang = language;
  document.querySelector('#label')!.textContent = messages[language].text;
  button.textContent = messages[language].submit;
  if (!api) result.textContent = messages[language].unavailable;
}
localize(api?.context.language);
const unsubscribe = api?.subscribe((event) => {
  if (event.topic === 'locale.changed' && event.data && typeof event.data === 'object' && 'language' in event.data && typeof event.data.language === 'string') localize(event.data.language);
});
window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!api || button.disabled) return;
  button.disabled = true;
  try {
    const output = await api.call('echo', { text: input.value });
    result.textContent = output.content.filter((item) => item.type === 'text').map((item) => String(item.text ?? '')).join('\n');
  } catch {
    result.textContent = messages[language].failed;
  } finally {
    button.disabled = false;
  }
});
