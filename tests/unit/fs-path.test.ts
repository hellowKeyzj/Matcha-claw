import { describe, expect, it } from 'vitest';
import { fsPath } from '../../electron/utils/fs-path';

describe('fsPath', () => {
  it('非 Windows 平台保持原样', () => {
    expect(fsPath('/Users/test/.openclaw/extensions', 'darwin')).toBe('/Users/test/.openclaw/extensions');
  });

  it('Windows 绝对盘符路径补 \\\\?\\ 前缀', () => {
    expect(fsPath('C:/Users/测试/.openclaw/extensions', 'win32')).toBe('\\\\?\\C:\\Users\\测试\\.openclaw\\extensions');
  });

  it('Windows UNC 路径补 \\\\?\\UNC\\ 前缀', () => {
    expect(fsPath('\\\\server\\share\\plugins', 'win32')).toBe('\\\\?\\UNC\\server\\share\\plugins');
  });

  it('已带前缀路径保持不变', () => {
    expect(fsPath('\\\\?\\C:\\Users\\测试\\plugins', 'win32')).toBe('\\\\?\\C:\\Users\\测试\\plugins');
  });
});
