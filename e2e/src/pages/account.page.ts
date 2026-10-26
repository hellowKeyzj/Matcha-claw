import { By, PageElement } from '@serenity-js/web';

export const AccountPage = {
  signInHeading: PageElement.located(By.role('heading', { level: 2, name: /^(Sign in|登录)$/ })).describedAs('sign-in heading'),
  registerHeading: PageElement.located(By.role('heading', { level: 2, name: /^(Create an account|创建账号)$/ })).describedAs('registration heading'),
  email: PageElement.located(By.id('email')).describedAs('account email'),
  password: PageElement.located(By.id('password')).describedAs('account password'),
  registerLink: PageElement.located(By.role('link', { name: /^(Create account|去注册)$/ })).describedAs('create-account link'),
  signInLink: PageElement.located(By.role('link', { name: /^(Sign in|登录)$/ })).describedAs('back-to-sign-in link'),
  registerSubmit: PageElement.located(By.role('button', { name: /^(Register|注册)$/ })).describedAs('register submit button'),
  signInSubmit: PageElement.located(By.role('button', { name: /^(Sign in|登录)$/ })).describedAs('sign-in submit button'),
  continueLocally: PageElement.located(By.role('button', { name: /^(Continue locally|Continue with local features|本地进入|离线进入)$/ })).describedAs('continue locally'),
  accountMenu: PageElement.located(By.role('button', { name: /^(Sign in to MatchaClaw|登录 MatchaClaw)$/ })).describedAs('sidebar account menu'),
  signInMenuItem: PageElement.located(By.role('menuitem', { name: /^(Sign in|登录)$/ })).describedAs('sign-in menu item'),
  expandSidebar: PageElement.located(By.role('button', { name: /^(Expand sidebar|展开侧边栏)$/ })).describedAs('expand navigation sidebar'),
  collapseSidebar: PageElement.located(By.role('button', { name: /^(Collapse sidebar|收起侧边栏)$/ })).describedAs('collapse navigation sidebar'),
};
