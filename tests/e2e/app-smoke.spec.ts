import { enterLocalWorkspace, expect, test } from './fixtures/electron';

test.describe('MatchaClaw Electron smoke', () => {
  test('应用可启动并渲染 Chat 页面', async ({ page }) => {
    await enterLocalWorkspace(page);
    await expect(page.getByRole('heading', { name: 'MatchaClaw 聊天' })).toBeVisible();
  });
});
