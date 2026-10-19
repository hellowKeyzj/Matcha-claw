/**
 * Adapted from docs/openclaw-source/ui/src/lib/board/grid.ts.
 * Copyright (c) 2026 OpenClaw Foundation
 * SPDX-License-Identifier: MIT — see LICENSE in this directory.
 */

export const BOARD_GRID_COLUMNS = 12;
export const BOARD_GRID_ROW_HEIGHT = 56;
export const BOARD_GRID_GAP = 12;
const BOARD_GRID_MAX_HEIGHT = 20;

export type BoardGridItem = {
  name: string;
  w: number;
  h: number;
  order: number;
};

export type BoardGridRect = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type BoardGridCell = {
  x: number;
  y: number;
};

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, integer));
}

function withOrder(item: BoardGridItem, order: number): BoardGridItem {
  return { name: item.name, w: item.w, h: item.h, order };
}

function canonicalItems(items: readonly BoardGridItem[]): BoardGridItem[] {
  return items
    .map((item) => ({
      name: item.name,
      w: clampInteger(item.w, 1, BOARD_GRID_COLUMNS),
      h: clampInteger(item.h, 1, BOARD_GRID_MAX_HEIGHT),
      order: Number.isFinite(item.order) ? item.order : 0,
    }))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map(withOrder);
}

function fits(occupied: readonly boolean[][], x: number, y: number, w: number, h: number): boolean {
  for (let row = y; row < y + h; row += 1) {
    for (let column = x; column < x + w; column += 1) {
      if (occupied[row]?.[column]) {
        return false;
      }
    }
  }
  return true;
}

function occupy(occupied: boolean[][], rect: BoardGridRect): void {
  for (let row = rect.y; row < rect.y + rect.h; row += 1) {
    const cells = occupied[row] ?? Array.from({ length: BOARD_GRID_COLUMNS }, () => false);
    occupied[row] = cells;
    for (let column = rect.x; column < rect.x + rect.w; column += 1) {
      cells[column] = true;
    }
  }
}

function firstFit(occupied: readonly boolean[][], item: BoardGridItem): BoardGridRect {
  for (let y = 0; ; y += 1) {
    for (let x = 0; x <= BOARD_GRID_COLUMNS - item.w; x += 1) {
      if (fits(occupied, x, y, item.w, item.h)) {
        return { name: item.name, x, y, w: item.w, h: item.h };
      }
    }
  }
}

/** Places canonical-order items at the first available row-major cell. */
export function layout(items: readonly BoardGridItem[]): BoardGridRect[] {
  return layoutCanonicalItems(canonicalItems(items));
}

function layoutCanonicalItems(items: readonly BoardGridItem[]): BoardGridRect[] {
  const occupied: boolean[][] = [];
  const rects: BoardGridRect[] = [];
  for (const item of items) {
    const placed = firstFit(occupied, item);
    occupy(occupied, placed);
    rects.push(placed);
  }
  return rects;
}

function contains(rect: BoardGridRect, cell: BoardGridCell): boolean {
  return (
    cell.x >= rect.x && cell.x < rect.x + rect.w && cell.y >= rect.y && cell.y < rect.y + rect.h
  );
}

/** Resolve targets before removing the moving item so successive previews stay stable. */
export function previewDrag(
  items: readonly BoardGridItem[],
  name: string,
  target: BoardGridCell & { name: string | undefined },
): BoardGridItem[] {
  const canonical = canonicalItems(items);
  const movingIndex = canonical.findIndex((item) => item.name === name);
  if (movingIndex < 0) {
    return canonical;
  }

  const currentRects = layoutCanonicalItems(canonical);
  const targetCell = currentRects.find((rect) => rect.name === target.name) ?? target;
  const cell = {
    x: clampInteger(targetCell.x, 0, BOARD_GRID_COLUMNS - 1),
    y: Math.max(0, Number.isFinite(targetCell.y) ? Math.floor(targetCell.y) : 0),
  };
  const currentRect = currentRects.find((rect) => rect.name === name);
  if (currentRect && contains(currentRect, cell)) {
    return canonical;
  }

  const [moving] = canonical.splice(movingIndex, 1);
  if (!moving) {
    return canonical;
  }
  const occupiedTarget = currentRects.find((rect) => rect.name !== name && contains(rect, cell));
  const nextRect =
    occupiedTarget ??
    currentRects
      .filter(
        (rect) =>
          rect.name !== name && (rect.y > cell.y || (rect.y === cell.y && rect.x >= cell.x)),
      )
      .sort((left, right) => left.y - right.y || left.x - right.x)[0];
  const insertionIndex = nextRect
    ? canonical.findIndex((item) => item.name === nextRect.name)
    : canonical.length;
  canonical.splice(Math.max(0, insertionIndex), 0, moving);
  return canonical.map(withOrder);
}

export function resize(
  items: readonly BoardGridItem[],
  name: string,
  w: number,
  h: number,
): BoardGridItem[] {
  return canonicalItems(items).map((item) =>
    item.name === name
      ? {
          name: item.name,
          w: clampInteger(w, 1, BOARD_GRID_COLUMNS),
          h: clampInteger(h, 1, BOARD_GRID_MAX_HEIGHT),
          order: item.order,
        }
      : item,
  );
}

/** Arrow-key fallback: left/up move earlier; right/down move later. */
export function nudge(
  items: readonly BoardGridItem[],
  name: string,
  direction: 'left' | 'right' | 'up' | 'down',
): BoardGridItem[] {
  const canonical = canonicalItems(items);
  const index = canonical.findIndex((item) => item.name === name);
  if (index < 0) {
    return canonical;
  }
  const delta = direction === 'left' || direction === 'up' ? -1 : 1;
  const target = Math.min(canonical.length - 1, Math.max(0, index + delta));
  if (target !== index) {
    const [moving] = canonical.splice(index, 1);
    if (moving) {
      canonical.splice(target, 0, moving);
    }
  }
  return canonical.map(withOrder);
}

const BOARD_WIDGET_FRAME_INSET = 12;
const BOARD_WIDGET_BORDER_PX = 1;
const BOARD_WIDGET_AUTO_MIN_ROWS = 2;
const BOARD_WIDGET_AUTO_MAX_ROWS = 20;

type BoardWidgetSizingInput = {
  contentKind: string;
  heightMode?: 'auto' | 'fixed';
  presentation?: 'card' | 'full-bleed' | 'frameless';
  sizeH: number;
};

function autoBoardWidgetHeightPx(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx: number,
): number | undefined {
  if (
    widget.contentKind !== 'html' ||
    widget.heightMode === 'fixed' ||
    contentHeightPx === undefined ||
    !Number.isFinite(contentHeightPx) ||
    contentHeightPx <= 0
  ) {
    return undefined;
  }
  return (
    contentHeightPx +
    BOARD_WIDGET_BORDER_PX * 2 +
    chromeRowPx +
    ((widget.presentation ?? 'card') === 'card' ? BOARD_WIDGET_FRAME_INSET * 2 : 0)
  );
}

function boardRowSpanPx(rows: number): number {
  return rows * BOARD_GRID_ROW_HEIGHT + (rows - 1) * BOARD_GRID_GAP;
}

export function effectiveBoardWidgetRows(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
): number {
  const requiredHeight = autoBoardWidgetHeightPx(widget, contentHeightPx, chromeRowPx);
  if (requiredHeight === undefined) {
    return widget.sizeH;
  }
  const rows = Math.ceil(
    (requiredHeight + BOARD_GRID_GAP) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
  );
  return Math.min(BOARD_WIDGET_AUTO_MAX_ROWS, Math.max(BOARD_WIDGET_AUTO_MIN_ROWS, rows));
}

/** Auto HTML cards hug their content within the quantized cell; others fill the cell. */
export function exactBoardWidgetHeightPx(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
): number | undefined {
  const requiredHeight = autoBoardWidgetHeightPx(widget, contentHeightPx, chromeRowPx);
  if (requiredHeight === undefined) {
    return undefined;
  }
  return Math.min(
    requiredHeight,
    boardRowSpanPx(effectiveBoardWidgetRows(widget, contentHeightPx, chromeRowPx)),
  );
}
