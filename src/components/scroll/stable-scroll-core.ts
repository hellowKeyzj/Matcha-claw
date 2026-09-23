const LINE_DELTA_PX = 16;
const PAGE_DELTA_RATIO = 0.86;
const TRACKPAD_DELTA_LIMIT = 8;
const WHEEL_DISTANCE_SCALE = 0.28;
const MAX_WHEEL_STEP_PX = 36;
const MAX_WHEEL_BUFFER_PX = 72;
const WHEEL_FRAME_COUNT = 3;
const MIN_FRAME_DELTA_PX = 0.5;

const frameScrollByScroller = new WeakMap<HTMLElement, FrameScrollState>();

interface FrameScrollState {
  remaining: number;
  framesLeft: number;
  rafId: number;
}

const INTERACTIVE_SELECTOR = [
  'textarea',
  'input',
  'select',
  '[contenteditable]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  'pre',
  'code',
  '.monaco-editor',
  '.xterm',
].join(',');

export function handleStableWheel(event: WheelEvent, scroller: HTMLElement): boolean {
  if (event.defaultPrevented || event.ctrlKey || prefersReducedMotion() || shouldYieldToTarget(event, scroller)) {
    return false;
  }

  const deltaY = normalizeWheelDeltaY(event, scroller);
  if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaY) <= TRACKPAD_DELTA_LIMIT) {
    return false;
  }

  if (!canScrollInDirection(scroller, deltaY)) {
    return false;
  }

  event.preventDefault();
  startFrameScroll(scroller, clampWheelDelta(deltaY * WHEEL_DISTANCE_SCALE));
  return true;
}

function normalizeWheelDeltaY(event: WheelEvent, scroller: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * LINE_DELTA_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * scroller.clientHeight * PAGE_DELTA_RATIO;
  }
  return event.deltaY;
}

function shouldYieldToTarget(event: WheelEvent, scroller: HTMLElement): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !scroller.contains(target)) {
    return true;
  }
  if (target.closest(INTERACTIVE_SELECTOR)) {
    return true;
  }
  return hasInnerScrollable(target, scroller, normalizeWheelDeltaY(event, scroller));
}

function hasInnerScrollable(target: Element, scroller: HTMLElement, deltaY: number): boolean {
  for (let element: Element | null = target; element && element !== scroller; element = element.parentElement) {
    if (isScrollableElement(element) && canScrollInDirection(element, deltaY)) {
      return true;
    }
  }
  return false;
}

function isScrollableElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const { overflowY } = window.getComputedStyle(element);
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
}

function canScrollInDirection(element: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) {
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  }
  return element.scrollTop > 1;
}

function clampWheelDelta(deltaY: number): number {
  return Math.sign(deltaY) * Math.min(Math.abs(deltaY), MAX_WHEEL_STEP_PX);
}

function startFrameScroll(scroller: HTMLElement, deltaY: number): void {
  const current = frameScrollByScroller.get(scroller);
  if (current) {
    const sameDirection = Math.sign(current.remaining) === Math.sign(deltaY);
    current.remaining = clampWheelBuffer(sameDirection ? current.remaining + deltaY : deltaY);
    current.framesLeft = WHEEL_FRAME_COUNT;
    return;
  }

  const state: FrameScrollState = {
    remaining: deltaY,
    framesLeft: WHEEL_FRAME_COUNT,
    rafId: 0,
  };
  frameScrollByScroller.set(scroller, state);

  const step = () => {
    const nextDelta = state.remaining / state.framesLeft;
    if (Math.abs(nextDelta) < MIN_FRAME_DELTA_PX || !canScrollInDirection(scroller, nextDelta)) {
      stopFrameScroll(scroller);
      return;
    }

    scroller.scrollTop += nextDelta;
    state.remaining -= nextDelta;
    state.framesLeft -= 1;
    if (state.framesLeft <= 0) {
      stopFrameScroll(scroller);
      return;
    }
    state.rafId = window.requestAnimationFrame(step);
  };

  state.rafId = window.requestAnimationFrame(step);
}

function clampWheelBuffer(deltaY: number): number {
  return Math.sign(deltaY) * Math.min(Math.abs(deltaY), MAX_WHEEL_BUFFER_PX);
}

function stopFrameScroll(scroller: HTMLElement): void {
  const state = frameScrollByScroller.get(scroller);
  if (!state) {
    return;
  }
  window.cancelAnimationFrame(state.rafId);
  frameScrollByScroller.delete(scroller);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
