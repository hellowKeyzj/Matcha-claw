import { officeSettings, setOfficeSettings, type OfficeSettingsPatch } from './client';
import { settingsLabels } from './labels';
import { chooseAction } from '../ui/document-actions';
import '../ui/dialogs.css';

export async function showOfficeSettings(): Promise<void> {
  const text = settingsLabels();
  let initial;
  try {
    initial = await officeSettings();
  } catch (error) {
    console.error(error);
    await chooseAction({ title: text.settings, message: text.loadError, actions: [] });
    return;
  }
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'matcha-library-dialog';
  const id = `office-settings-${crypto.randomUUID()}`;
  const title = document.createElement('h2');
  title.id = id;
  title.textContent = text.settings;
  dialog.setAttribute('aria-labelledby', id);
  const form = document.createElement('form');
  const addSelect = (labelText: string, options: readonly (readonly [string, string])[], value: string) => {
    const row = document.createElement('p');
    const label = document.createElement('label');
    const select = document.createElement('select');
    for (const [value, title] of options) select.add(new Option(title, value));
    select.value = value;
    label.append(document.createTextNode(labelText), document.createElement('br'), select);
    row.append(label);
    form.append(row);
    return select;
  };
  const theme = addSelect(text.documentTheme, [['follow', text.follow], ['light', text.light], ['dark', text.dark]], initial.documentTheme);
  theme.autofocus = true;
  const autoSave = addSelect(text.autoSave, [['on', text.on], ['off', text.off]], initial.autoSaveDefault.on ? 'on' : 'off');
  const autoSaveHint = document.createElement('p');
  autoSaveHint.id = `${id}-auto-save`;
  autoSaveHint.textContent = text.autoSaveHint;
  autoSave.setAttribute('aria-describedby', autoSaveHint.id);
  const authorLabel = document.createElement('label');
  const author = document.createElement('input');
  author.type = 'text';
  author.maxLength = 120;
  author.value = initial.authorNameSetting.value;
  author.placeholder = initial.authorNameSetting.fallback;
  author.spellcheck = false;
  author.autocomplete = 'off';
  authorLabel.append(document.createTextNode(text.authorName), author);
  const authorHint = document.createElement('p');
  authorHint.id = `${id}-author`;
  authorHint.textContent = text.authorHint;
  author.setAttribute('aria-describedby', authorHint.id);
  const errorMessage = document.createElement('p');
  errorMessage.setAttribute('role', 'alert');
  errorMessage.hidden = true;
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = text.save;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = text.cancel;
  cancel.onclick = () => dialog.close();
  form.append(autoSaveHint, authorLabel, authorHint, errorMessage, save, cancel);
  dialog.append(title, form);
  let saving = false;
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const patch: OfficeSettingsPatch = {};
    if (theme.value !== initial.documentTheme) patch.documentTheme = theme.value as OfficeSettingsPatch['documentTheme'];
    if ((autoSave.value === 'on') !== initial.autoSaveDefault.on) patch.autoSaveDefault = autoSave.value === 'on';
    if (author.value !== initial.authorNameSetting.value) patch.authorName = author.value;
    saving = true;
    theme.disabled = autoSave.disabled = author.disabled = save.disabled = cancel.disabled = true;
    form.setAttribute('aria-busy', 'true');
    errorMessage.hidden = true;
    try {
      await setOfficeSettings(patch);
      dialog.close();
    } catch (error) {
      console.error(error);
      errorMessage.textContent = text.saveError;
      errorMessage.hidden = false;
    } finally {
      saving = false;
      theme.disabled = autoSave.disabled = author.disabled = save.disabled = cancel.disabled = false;
      form.removeAttribute('aria-busy');
    }
  };
  await new Promise<void>((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
