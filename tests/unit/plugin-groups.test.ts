import { describe, expect, it } from 'vitest';
import { pickCatalogGroup } from '../../runtime-host/application/plugins/plugin-groups';

describe('plugin group mapping', () => {
  it('带 channel 配置的插件归到 channel 组', () => {
    expect(pickCatalogGroup({
      id: 'slack',
      category: 'general',
      groupHints: {
        channel: true,
        model: false,
      },
    })).toBe('channel');
  });

  it('provider/speech/media 能力插件归到 model 组', () => {
    expect(pickCatalogGroup({
      id: 'openai',
      category: 'general',
      groupHints: {
        channel: false,
        model: true,
      },
    })).toBe('model');
  });

  it('runtime 核心包归到 model 组', () => {
    expect(pickCatalogGroup({
      id: '@openclaw/image-generation-core',
      category: 'general',
      description: 'OpenClaw image generation runtime package',
      groupHints: {
        channel: false,
        model: false,
      },
    })).toBe('model');
  });

  it('voice-call 归到 channel 组', () => {
    expect(pickCatalogGroup({
      id: 'voice-call',
      category: 'general',
      groupHints: {
        channel: false,
        model: false,
      },
    })).toBe('channel');
  });

  it('其他类别插件归到 general 组', () => {
    expect(pickCatalogGroup({
      id: 'task-manager',
      category: 'tools',
      groupHints: {
        channel: false,
        model: false,
      },
    })).toBe('general');
  });
});
