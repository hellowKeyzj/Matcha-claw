import { describe, expect, it } from 'vitest';
import { CHANNEL_ICON_IDS, CHANNEL_META, getPrimaryChannels } from '@/types/channel';

describe('primary channel list', () => {
  it('只暴露当前可配置频道目录', () => {
    expect(getPrimaryChannels()).toEqual([
      'openclaw-weixin',
      'qqbot',
      'dingtalk',
      'wecom',
      'feishu',
    ]);
  });

  it('保持五个主频道的展示类型、图标和接入流程模型', () => {
    expect(CHANNEL_META['openclaw-weixin'].connectionType).toBe('qr');
    expect(CHANNEL_META['openclaw-weixin'].iconId).toBe('wechat');
    expect(CHANNEL_META['openclaw-weixin'].setupFlows).toEqual([{ mode: 'guided', flow: { kind: 'qr-login' } }]);
    expect(CHANNEL_META.qqbot.connectionType).toBe('qr');
    expect(CHANNEL_META.qqbot.iconId).toBe('qqbot');
    expect(CHANNEL_META.qqbot.setupFlows).toEqual([
      { mode: 'guided', flow: { kind: 'authorization', presentation: 'qr' } },
      { mode: 'credential' },
    ]);
    expect(CHANNEL_META.dingtalk.connectionType).toBe('oauth');
    expect(CHANNEL_META.dingtalk.iconId).toBe('dingtalk');
    expect(CHANNEL_META.dingtalk.setupFlows).toEqual([
      { mode: 'guided', flow: { kind: 'authorization', presentation: 'qr-or-link' } },
      { mode: 'credential' },
    ]);
    expect(CHANNEL_META.feishu.connectionType).toBe('oauth');
    expect(CHANNEL_META.feishu.iconId).toBe('feishu');
    expect(CHANNEL_META.feishu.setupFlows).toEqual([
      { mode: 'guided', flow: { kind: 'authorization', presentation: 'qr-or-link' } },
      { mode: 'credential' },
    ]);
    expect(CHANNEL_META.wecom.connectionType).toBe('token');
    expect(CHANNEL_META.wecom.iconId).toBe('wecom');
    expect(CHANNEL_META.wecom.setupFlows).toEqual([{ mode: 'credential' }]);
  });

  it('所有频道元数据都使用独立 iconId', () => {
    for (const channelType of Object.keys(CHANNEL_META) as Array<keyof typeof CHANNEL_META>) {
      expect(CHANNEL_META[channelType].iconId).toBe(CHANNEL_ICON_IDS[channelType]);
    }
  });
});
