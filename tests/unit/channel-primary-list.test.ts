import { describe, expect, it } from 'vitest';
import { getPrimaryChannels, isPrimaryChannelVisible } from '@/types/channel';

describe('primary channel list', () => {
  it('默认隐藏暂未开放的传统 IM 频道入口', () => {
    expect(getPrimaryChannels()).toEqual([
      'dingtalk',
      'feishu',
      'wecom',
      'openclaw-weixin',
      'qqbot',
    ]);

    expect(isPrimaryChannelVisible('telegram')).toBe(false);
    expect(isPrimaryChannelVisible('discord')).toBe(false);
    expect(isPrimaryChannelVisible('whatsapp')).toBe(false);
    expect(isPrimaryChannelVisible('dingtalk')).toBe(true);
  });
});
