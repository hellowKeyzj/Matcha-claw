import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

function dateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isValidDateValue(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return dateValue(new Date(`${value}T00:00:00`)) === value;
}

function shouldStartWeekOnSunday(locale: string): boolean {
  const language = locale.toLowerCase().split('-')[0];
  return language === 'zh' || language === 'ja' || language === 'en';
}

function moveMonth(date: Date, offset: number) {
  const next = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), lastDay));
  return next;
}

function CalendarMonth({ value, locale, onSelect }: {
  value: string;
  locale: string;
  onSelect: (value: string) => void;
}) {
  const [focusedDate, setFocusedDate] = useState(() => value ? new Date(`${value}T00:00:00`) : new Date());
  const year = focusedDate.getFullYear();
  const month = focusedDate.getMonth();
  const weekStartsOn = shouldStartWeekOnSunday(locale) ? 0 : 1;
  const firstDay = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const monthFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' });
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const today = dateValue(new Date());
  const focusDay = useCallback((node: HTMLButtonElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const next = new Date(date);
    switch (event.key) {
      case 'ArrowLeft': next.setDate(date.getDate() - 1); break;
      case 'ArrowRight': next.setDate(date.getDate() + 1); break;
      case 'ArrowUp': next.setDate(date.getDate() - 7); break;
      case 'ArrowDown': next.setDate(date.getDate() + 7); break;
      case 'Home': next.setDate(date.getDate() - ((date.getDay() - weekStartsOn + 7) % 7)); break;
      case 'End': next.setDate(date.getDate() + 6 - ((date.getDay() - weekStartsOn + 7) % 7)); break;
      case 'PageUp': event.preventDefault(); setFocusedDate(moveMonth(date, -1)); return;
      case 'PageDown': event.preventDefault(); setFocusedDate(moveMonth(date, 1)); return;
      default: return;
    }
    event.preventDefault();
    setFocusedDate(next);
  };

  return (
    <div className="w-72 p-3">
      <div className="mb-3 flex items-center justify-between">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
          aria-label={monthFormat.format(moveMonth(focusedDate, -1))}
          onClick={() => setFocusedDate(moveMonth(focusedDate, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium" aria-live="polite">{monthFormat.format(focusedDate)}</span>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
          aria-label={monthFormat.format(moveMonth(focusedDate, 1))}
          onClick={() => setFocusedDate(moveMonth(focusedDate, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, day) => (
          <span key={`weekday-${day}`} className="py-1 text-center text-xs text-muted-foreground">
            {weekdayFormat.format(new Date(2026, 0, 4 + ((day + weekStartsOn) % 7)))}
          </span>
        ))}
        {Array.from({ length: firstDay }, (_, day) => <span key={`empty-${day}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const date = new Date(year, month, index + 1);
          const iso = dateValue(date);
          const focused = index + 1 === focusedDate.getDate();
          return (
            <button
              key={iso}
              ref={focused ? focusDay : undefined}
              type="button"
              tabIndex={focused ? 0 : -1}
              aria-label={dayFormat.format(date)}
              aria-pressed={iso === value}
              aria-current={iso === today ? 'date' : undefined}
              className={cn(
                'h-8 rounded-lg text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
                iso === value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                iso === today && iso !== value && 'font-semibold text-primary',
              )}
              onKeyDown={(event) => handleKeyDown(event, date)}
              onClick={() => onSelect(iso)}
            >{index + 1}</button>
          );
        })}
      </div>
    </div>
  );
}

export function DatePicker({ id, label, placeholder, value, onChange, locale }: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  locale: string;
}) {
  const uniqueId = useId().replace(/:/g, '');
  const popoverId = `${id}-calendar`;
  const anchorName = `--date-${uniqueId}`;
  const fieldRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const skipFieldClickRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const commitInputValue = (nextValue: string) => {
    const trimmedValue = nextValue.trim();
    if (!trimmedValue || isValidDateValue(trimmedValue)) {
      onChange(trimmedValue);
      setInputValue(trimmedValue);
    } else {
      setInputValue(value);
    }
  };

  const handleFieldPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (open && event.button === 0) {
      event.preventDefault();
      skipFieldClickRef.current = true;
      popoverRef.current?.hidePopover();
    }
  };

  const handleFieldClick = () => {
    if (skipFieldClickRef.current) {
      skipFieldClickRef.current = false;
      return;
    }
    if (!open) {
      popoverRef.current?.showPopover();
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">{label}</label>
      <div
        ref={fieldRef}
        style={{ anchorName } as CSSProperties}
        className="flex h-9 w-40 items-center rounded-md border border-input bg-background text-sm outline-none focus-within:ring-2 focus-within:ring-ring hover:border-border"
        onPointerDown={handleFieldPointerDown}
        onClick={handleFieldClick}
      >
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={inputValue}
          placeholder={placeholder}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent px-3 outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            const nextValue = event.target.value;
            setInputValue(nextValue);
            if (!nextValue) {
              onChange('');
            } else if (isValidDateValue(nextValue)) {
              onChange(nextValue);
            }
          }}
          onBlur={(event) => commitInputValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitInputValue(event.currentTarget.value);
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Calendar className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-label={label}
        onToggle={(event) => setOpen(event.newState === 'open')}
        style={{ positionAnchor: anchorName, top: 'anchor(bottom)', left: 'auto', right: 'anchor(right)', positionTryFallbacks: 'flip-block, flip-inline', margin: '6px 0' } as CSSProperties}
        className="fixed rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-elevated"
      >
        {open && <CalendarMonth value={value} locale={locale} onSelect={(date) => {
          onChange(date);
          setInputValue(date);
          popoverRef.current?.hidePopover();
        }} />}
      </div>
    </div>
  );
}
