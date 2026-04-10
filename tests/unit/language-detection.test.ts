import { describe, expect, it } from 'vitest';
import { resolveSupportedLanguage } from '../../src/i18n/language';

describe('resolveSupportedLanguage', () => {
  it('支持区域语言并归一化为基础语言代码', () => {
    expect(resolveSupportedLanguage('zh-CN')).toBe('zh');
    expect(resolveSupportedLanguage('ja_JP')).toBe('ja');
    expect(resolveSupportedLanguage('en-US')).toBe('en');
  });

  it('不支持的语言会回退到英文', () => {
    expect(resolveSupportedLanguage('fr-FR')).toBe('en');
    expect(resolveSupportedLanguage('ko')).toBe('en');
  });

  it('空值会回退到英文', () => {
    expect(resolveSupportedLanguage('')).toBe('en');
    expect(resolveSupportedLanguage(undefined)).toBe('en');
  });
});
