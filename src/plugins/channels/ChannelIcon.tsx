import type { ImgHTMLAttributes } from 'react';
import wechat from '@/assets/channels/wechat.svg';
import qqbot from '@/assets/channels/qqbot.svg';
import dingtalk from '@/assets/channels/dingtalk.svg';
import wecom from '@/assets/channels/wecom.svg';
import feishu from '@/assets/channels/feishu.svg';
import whatsapp from '@/assets/channels/whatsapp.svg';
import telegram from '@/assets/channels/telegram.svg';
import discord from '@/assets/channels/discord.svg';
import signal from '@/assets/channels/signal.svg';
import imessage from '@/assets/channels/imessage.svg';
import matrix from '@/assets/channels/matrix.svg';
import line from '@/assets/channels/line.svg';
import msteams from '@/assets/channels/msteams.svg';
import googlechat from '@/assets/channels/googlechat.svg';
import mattermost from '@/assets/channels/mattermost.svg';
import type { ChannelIconId } from '@/types/channel';
import { cn } from '@/lib/utils';

type ChannelIconProps = ImgHTMLAttributes<HTMLImageElement> & {
  id: ChannelIconId;
};

const CHANNEL_ICON_SOURCES: Record<ChannelIconId, string> = {
  wechat,
  qqbot,
  dingtalk,
  wecom,
  feishu,
  whatsapp,
  telegram,
  discord,
  signal,
  imessage,
  matrix,
  line,
  msteams,
  googlechat,
  mattermost,
};

export function ChannelIcon({ id, className, alt = '', ...props }: ChannelIconProps) {
  return <img src={CHANNEL_ICON_SOURCES[id]} alt={alt} className={cn('h-6 w-6 object-contain', className)} {...props} />;
}
