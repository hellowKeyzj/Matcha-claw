export const MESSAGE_LAYOUT_TOKENS = {
  messageShell: 'group grid w-full items-start gap-2 py-1 max-md:gap-2 max-sm:gap-1.5',
  messageShellAssistantColumns: 'grid-cols-[auto_minmax(0,1fr)]',
  messageShellUserColumns: 'grid-cols-[minmax(0,1fr)_auto]',
  messageAvatar: 'mt-1 flex h-8 w-8 shrink-0 self-start items-center justify-center rounded-full max-md:h-7 max-md:w-7 max-[400px]:hidden',
  messageAvatarAssistantOrder: 'order-1',
  messageAvatarUserOrder: 'order-2',
  messageContentColumn: 'flex min-w-0 w-full flex-col space-y-1',
  messageContentAssistantOrder: 'order-2 max-w-[46rem] justify-self-stretch items-start pr-4 sm:pr-6',
  messageContentUserOrder: 'order-1 justify-self-stretch items-end pl-4 sm:pl-6',
  userBubble: 'relative max-w-[min(32rem,100%)] rounded-[18px] rounded-tr-md border border-border/42 bg-background/92 px-4 py-2.5 text-[14px] leading-[1.58] text-foreground shadow-[0_6px_22px_rgba(15,23,42,0.045)] max-md:rounded-[16px] max-md:px-3.5 max-md:py-2.5 max-sm:px-3 max-sm:py-2',
  assistantSurface: 'w-full rounded-[18px] bg-transparent px-0.5 py-0.5 max-md:px-0 max-md:py-0',
} as const;
