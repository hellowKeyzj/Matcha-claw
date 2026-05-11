import {
  asRecord,
  joinDetailParts,
  previewText,
  quoteText,
  resolveArrayPreview,
} from './tool-display-format';

export function resolveMessageActionDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const provider = typeof record.provider === 'string' ? record.provider.trim() : undefined;
  const to = typeof record.to === 'string' ? record.to.trim() : undefined;
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : undefined;
  const emoji = typeof record.emoji === 'string' ? record.emoji.trim() : undefined;
  const query = typeof record.query === 'string' ? record.query.trim() : undefined;
  const content = typeof record.content === 'string' ? record.content.trim() : undefined;
  const channelId = typeof record.channelId === 'string' ? record.channelId.trim() : undefined;
  const guildId = typeof record.guildId === 'string' ? record.guildId.trim() : undefined;
  const userId = typeof record.userId === 'string' ? record.userId.trim() : undefined;
  const roleId = typeof record.roleId === 'string' ? record.roleId.trim() : undefined;
  const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : undefined;
  const stickerId = typeof record.stickerId === 'string' ? record.stickerId.trim() : undefined;
  const stickerName = typeof record.stickerName === 'string' ? record.stickerName.trim() : undefined;
  const emojiName = typeof record.emojiName === 'string' ? record.emojiName.trim() : undefined;
  const eventName = typeof record.eventName === 'string' ? record.eventName.trim() : undefined;
  const stickerIds = resolveArrayPreview(record.stickerIds, { maxArrayEntries: 2, maxStringChars: 24 });
  const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
    ? Math.floor(record.limit)
    : undefined;
  const pollQuestion = typeof record.pollQuestion === 'string' ? record.pollQuestion.trim() : undefined;
  const threadName = typeof record.threadName === 'string' ? record.threadName.trim() : undefined;

  switch (action) {
    case 'send':
      return joinDetailParts([
        to ? `发送到 ${to}` : '发送消息',
        provider ? `通过 ${provider}` : undefined,
        content ? `内容 ${previewText(content, 36)}` : undefined,
      ]);
    case 'read':
      return joinDetailParts([
        to ? `查看 ${to} 的消息` : '查看消息',
        limit ? `最近 ${limit} 条` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'react':
      return joinDetailParts([
        messageId ? `给消息 ${messageId} 添加回应` : '添加回应',
        emoji ? `表情 ${emoji}` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'reactions':
      return joinDetailParts([
        messageId ? `查看消息 ${messageId} 的回应` : '查看消息回应',
        limit ? `最多 ${limit} 条` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'edit':
      return joinDetailParts([
        messageId ? `编辑消息 ${messageId}` : undefined,
        to ? `位置 ${to}` : undefined,
      ]);
    case 'delete':
      return joinDetailParts([
        messageId ? `删除消息 ${messageId}` : undefined,
        to ? `位置 ${to}` : undefined,
      ]);
    case 'pin':
      return messageId ? `置顶消息 ${messageId}` : '置顶消息';
    case 'unpin':
      return messageId ? `取消置顶 ${messageId}` : '取消置顶消息';
    case 'list-pins':
      return joinDetailParts([
        to ? `查看 ${to} 的置顶消息` : '查看置顶消息',
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'poll':
      return joinDetailParts([
        pollQuestion ? `发起投票 ${quoteText(pollQuestion)}` : '发起投票',
        to ? `位置 ${to}` : undefined,
      ]);
    case 'search':
      return joinDetailParts([
        query ? `搜索消息 ${quoteText(query)}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'thread-create':
      return joinDetailParts([
        threadName ? `创建线程 ${threadName}` : '创建线程',
        channelId ? `频道 ${channelId}` : undefined,
      ]);
    case 'thread-list':
      return joinDetailParts([
        '查看线程列表',
        to ? `位置 ${to}` : undefined,
        channelId ? `频道 ${channelId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'thread-reply':
      return joinDetailParts([
        messageId ? `回复线程消息 ${messageId}` : '回复线程',
        channelId ? `频道 ${channelId}` : undefined,
        threadId ? `线程 ${threadId}` : undefined,
      ]);
    case 'permissions':
      return joinDetailParts([
        '查看频道权限',
        channelId ? `频道 ${channelId}` : undefined,
        to ? `目标 ${to}` : undefined,
      ]);
    case 'sticker':
      return joinDetailParts([
        to ? `发送贴纸到 ${to}` : '发送贴纸',
        stickerId ? `贴纸 ${stickerId}` : stickerIds,
      ]);
    case 'member-info':
      return joinDetailParts([
        userId ? `查看成员 ${userId}` : '查看成员信息',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-info':
      return guildId ? `查看群组 ${guildId} 的角色信息` : '查看角色信息';
    case 'emoji-list':
      return guildId ? `查看群组 ${guildId} 的表情列表` : '查看表情列表';
    case 'emoji-upload':
      return joinDetailParts([
        emojiName ? `上传表情 ${emojiName}` : '上传表情',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'sticker-upload':
      return joinDetailParts([
        stickerName ? `上传贴纸 ${stickerName}` : '上传贴纸',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-add':
      return joinDetailParts([
        userId ? `为 ${userId} 添加角色` : '添加角色',
        roleId ? `角色 ${roleId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-remove':
      return joinDetailParts([
        userId ? `移除 ${userId} 的角色` : '移除角色',
        roleId ? `角色 ${roleId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'channel-info':
      return channelId ? `查看频道 ${channelId} 的信息` : '查看频道信息';
    case 'channel-list':
      return guildId ? `查看群组 ${guildId} 的频道列表` : '查看频道列表';
    case 'voice-status':
      return joinDetailParts([
        userId ? `查看 ${userId} 的语音状态` : '查看语音状态',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'event-list':
      return guildId ? `查看群组 ${guildId} 的事件列表` : '查看事件列表';
    case 'event-create':
      return joinDetailParts([
        eventName ? `创建事件 ${eventName}` : '创建事件',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'timeout':
      return joinDetailParts([
        userId ? `设置 ${userId} 的禁言` : '设置禁言',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'kick':
      return joinDetailParts([
        userId ? `移出成员 ${userId}` : '移出成员',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'ban':
      return joinDetailParts([
        userId ? `封禁成员 ${userId}` : '封禁成员',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    default:
      return undefined;
  }
}
