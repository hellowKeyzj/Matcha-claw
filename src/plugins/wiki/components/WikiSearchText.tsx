import type { JSX } from 'react';

export function WikiSearchText({ text, tokens }: Readonly<{ text: string; tokens: readonly string[] }>): JSX.Element {
  if (tokens.length === 0) return <>{text}</>;
  const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'));

  return <>{parts.map((part, index) => index % 2 === 1
    ? <mark key={index} className="rounded bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-800">{part}</mark>
    : <span key={index}>{part}</span>)}</>;
}
