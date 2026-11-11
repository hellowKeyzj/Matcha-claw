import { chooseAction } from '../ui/document-actions';
import { t } from '../../genoffice/apps/docs/src/renderer/i18n/locale';
import { docsDialogLabels } from './labels';

export async function showDocsMessage(message: string): Promise<void> {
  await chooseAction({ title: 'Docs', message, actions: [{ value: 'ok', label: t('appOk') }], cancel: false });
}

export async function confirmDocsAction(message: string): Promise<boolean> {
  return await chooseAction({ title: 'Docs', message, actions: [{ value: 'ok', label: t('appOk') }] }) === 'ok';
}

export async function displayDocsZoteroAlert(message: string, buttons: number): Promise<number> {
  if (buttons === 0) { await showDocsMessage(message); return 0; }
  const labels = docsDialogLabels();
  const actions = buttons === 1 ? [{ value: '1', label: t('appOk') }]
    : [{ value: buttons === 3 ? '2' : '1', label: labels.yes }, { value: buttons === 3 ? '1' : '0', label: labels.no }];
  const choice = await chooseAction({ title: 'Zotero', message, actions, cancel: buttons === 1 || buttons === 3 });
  return choice === null ? 0 : Number(choice);
}
