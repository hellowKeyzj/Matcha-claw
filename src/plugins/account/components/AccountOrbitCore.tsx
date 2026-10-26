type AccountOrbitCoreSize = 'compact' | 'boot' | 'hero';

type AccountOrbitCoreProps = {
  className?: string;
  size?: AccountOrbitCoreSize;
};

const ROOT_SIZE: Record<AccountOrbitCoreSize, string> = {
  compact: 'h-14 w-14',
  boot: 'h-44 w-44',
  hero: 'h-64 w-64',
};

const SHELL_INSET: Record<AccountOrbitCoreSize, string> = {
  compact: 'inset-1.5',
  boot: 'inset-4',
  hero: 'inset-6',
};

const RING_INSET: Record<AccountOrbitCoreSize, string> = {
  compact: 'inset-3.5',
  boot: 'inset-12',
  hero: 'inset-20',
};

const MARK_SIZE: Record<AccountOrbitCoreSize, string> = {
  compact: 'h-7 w-7 text-sm',
  boot: 'h-14 w-14 text-xl',
  hero: 'h-20 w-20 text-3xl',
};

export function AccountOrbitCore({ className = '', size = 'hero' }: AccountOrbitCoreProps) {
  return (
    <div className={`relative grid place-items-center ${ROOT_SIZE[size]} ${className}`} aria-hidden="true">
      <div className="absolute inset-0 rounded-full bg-ring/10 blur-2xl" />
      <div className={`absolute ${SHELL_INSET[size]} rounded-[34%] border border-border/70 bg-card/80 shadow-elevated`} />
      <div className={`absolute ${SHELL_INSET[size]} rotate-45 rounded-[34%] border border-ring/15`} />
      <div className={`absolute ${SHELL_INSET[size]} -rotate-12 rounded-[42%] border border-border/55`} />
      <div className={`absolute ${RING_INSET[size]} rounded-full border border-ring/15`} />
      <div
        className={`absolute ${RING_INSET[size]} rounded-full motion-safe:animate-spin`}
        style={{
          animationDuration: '1.05s',
          background: 'conic-gradient(from 12deg, hsl(var(--ring)) 0deg, hsl(var(--ring) / 0.76) 86deg, transparent 112deg, transparent 360deg)',
          mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
          WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
        }}
      />
      <div className={`relative grid place-items-center rounded-[30%] border border-border bg-background font-semibold tracking-[-0.03em] text-foreground shadow-whisper ${MARK_SIZE[size]}`}>
        M
      </div>
    </div>
  );
}
