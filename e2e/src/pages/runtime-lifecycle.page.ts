import { By } from '@serenity-js/web';
import { LicensePage } from './license.page.js';
import { ProxyPage } from './proxy.page.js';

const hostRow = LicensePage.settings.element(By.xpath('.//*[@role="listitem"][.//span[normalize-space(.)="Runtime Host"]]'));
const openClawRow = LicensePage.settings.element(By.xpath('.//*[@role="listitem"][.//span[normalize-space(.)="OpenClaw"]]'));

export const RuntimeLifecyclePage = {
  openSettings: LicensePage.openSettings,
  settings: LicensePage.settings,
  runtimeStatus: ProxyPage.runtimeStatus,
  hostRow,
  hostStatus: hostRow.element(By.xpath('./div[2]/span')).describedAs('Runtime Host status in Settings'),
  openClawStatus: openClawRow.element(By.xpath('./div[2]/span')).describedAs('OpenClaw status in Settings'),
};
