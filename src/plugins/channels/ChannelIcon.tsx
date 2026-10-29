import type { ImgHTMLAttributes } from 'react';
import wechat from './assets/wechat.svg';
import qqbot from './assets/qqbot.svg';
import dingtalk from './assets/dingtalk.svg';
import wecom from './assets/wecom.svg';
import feishu from './assets/feishu.svg';
import whatsapp from './assets/whatsapp.svg';
import telegram from './assets/telegram.svg';
import discord from './assets/discord.svg';
import signal from './assets/signal.svg';
import imessage from './assets/imessage.svg';
import matrix from './assets/matrix.svg';
import line from './assets/line.svg';
import msteams from './assets/msteams.svg';
import googlechat from './assets/googlechat.svg';
import mattermost from './assets/mattermost.svg';
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
