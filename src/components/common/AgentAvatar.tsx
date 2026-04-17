import { memo, useMemo } from 'react';
import { createAvatar, type BackgroundType } from '@dicebear/core';
import { bottts, botttsNeutral, pixelArt } from '@dicebear/collection';
import {
  resolveAgentAvatarSeed,
  resolveAgentAvatarStyle,
  type AgentAvatarStyle,
} from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';

const AGENT_AVATAR_BACKGROUND_COLORS = [
  'cfe8ff',
  'd8f5d0',
  'ffe0c9',
  'f8d8e8',
  'e4dcff',
  'f9efc7',
];

const avatarDataUriCache = new Map<string, string>();

function getAvatarDataUri(style: AgentAvatarStyle, seed: string): string {
  const cacheKey = `${style}:${seed}`;
  const cached = avatarDataUriCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const options = {
    seed,
    size: 64,
    radius: 50,
    backgroundType: ['solid'] as BackgroundType[],
    backgroundColor: AGENT_AVATAR_BACKGROUND_COLORS,
    randomizeIds: true,
  };
  const dataUri = (
    style === 'bottts'
      ? createAvatar(bottts, options)
      : style === 'botttsNeutral'
        ? createAvatar(botttsNeutral, options)
        : createAvatar(pixelArt, options)
  ).toDataUri();

  avatarDataUriCache.set(cacheKey, dataUri);
  return dataUri;
}

interface AgentAvatarProps {
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  agentId?: string;
  agentName?: string;
  className?: string;
  imageClassName?: string;
  alt?: string;
  title?: string;
  dataTestId?: string;
}

export const AgentAvatar = memo(function AgentAvatar({
  avatarSeed,
  avatarStyle,
  agentId,
  agentName,
  className,
  imageClassName,
  alt,
  title,
  dataTestId,
}: AgentAvatarProps) {
  const resolvedName = agentName?.trim() || agentId?.trim() || 'Agent';
  const style = useMemo(
    () => resolveAgentAvatarStyle(avatarStyle),
    [avatarStyle],
  );
  const seed = useMemo(
    () => resolveAgentAvatarSeed({ avatarSeed, agentId, agentName }),
    [agentId, agentName, avatarSeed],
  );
  const src = useMemo(() => getAvatarDataUri(style, seed), [seed, style]);

  return (
    <span
      className={cn('inline-flex shrink-0 overflow-hidden rounded-full bg-muted', className)}
      title={title}
      data-testid={dataTestId}
    >
      <img
        src={src}
        alt={alt ?? `${resolvedName} avatar`}
        className={cn('h-full w-full object-cover', imageClassName)}
        draggable={false}
        style={{ imageRendering: style === 'pixelArt' ? 'pixelated' : 'auto' }}
      />
    </span>
  );
});

export default AgentAvatar;
