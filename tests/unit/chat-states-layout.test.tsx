import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeScreen } from '@/pages/Chat/components/ChatStates';

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
});
