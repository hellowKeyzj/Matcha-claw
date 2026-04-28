import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityIndicator, TypingIndicator, WelcomeScreen } from '@/pages/Chat/components/ChatStates';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('chat states layout', () => {
  it('welcome screen uses passive cards instead of clickable old-style tiles', () => {
    const { container } = render(<WelcomeScreen />);

    expect(screen.getByText('welcome.title')).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    const cards = Array.from(container.querySelectorAll('div'))
      .map((node) => node.className)
      .filter((className): className is string => typeof className === 'string');

    expect(cards.some((className) => className.includes('backdrop-blur-sm'))).toBe(true);
    expect(cards.some((className) => className.includes('shadow-'))).toBe(true);
  });

  it('typing and activity indicators use the new light surface instead of gradient bubbles', () => {
    const { container, rerender } = render(<TypingIndicator />);

    let classNames = Array.from(container.querySelectorAll('div'))
      .map((node) => node.className)
      .filter((className): className is string => typeof className === 'string');

    expect(classNames.some((className) => className.includes('bg-gradient-to-br'))).toBe(false);
    expect(classNames.some((className) => className.includes('backdrop-blur-sm'))).toBe(true);

    rerender(<ActivityIndicator />);
    classNames = Array.from(container.querySelectorAll('div'))
      .map((node) => node.className)
      .filter((className): className is string => typeof className === 'string');

    expect(classNames.some((className) => className.includes('bg-gradient-to-br'))).toBe(false);
    expect(classNames.some((className) => className.includes('backdrop-blur-sm'))).toBe(true);
  });
});
