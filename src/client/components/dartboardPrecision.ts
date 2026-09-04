import { SVG_SIZE } from './boardGeometry';

/** A deliberate hold should feel prompt without turning an ordinary tap into a surprise. */
export const HOLD_TO_AIM_MS = 420;

/** The precision view turns a roughly 10 mm bed into a comfortably finger-sized target. */
export const PRECISION_ZOOM = 2.35;

/** The dart's scoring tip sits here relative to the finger whenever screen space allows it. */
const DESIRED_TIP_OFFSET_PX = { x: 48, y: 82 };

/** Never deliberately place the scoring tip flush against a physical screen or SVG edge. */
const TIP_EDGE_INSET_PX = 48;

export interface SvgPoint {
  x: number;
  y: number;
}

export interface BoardViewBox {
  x: number;
  y: number;
  size: number;
}

export interface PrecisionOrigin {
  clientX: number;
  clientY: number;
  tip: SvgPoint;
}

export const NORMAL_VIEW_BOX: BoardViewBox = { x: 0, y: 0, size: SVG_SIZE };

export function pointInView(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  viewBox: BoardViewBox,
): SvgPoint {
  return {
    x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.size,
    y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.size,
  };
}

export function keepOnBoard(point: SvgPoint): SvgPoint {
  return {
    x: Math.max(0, Math.min(SVG_SIZE, point.x)),
    y: Math.max(0, Math.min(SVG_SIZE, point.y)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Put the tip at a stable physical offset from the finger, then honour both kinds of boundary.
 *
 * First the desired client position is kept inside the visible intersection of the SVG and the
 * mobile visual viewport. The viewBox is then positioned to map the held board point there and
 * clamped to the board's 0–100 square. That second clamp is the only remaining reason the physical
 * offset can shrink near an outer coordinate edge.
 */
export function precisionViewBox(
  point: SvgPoint,
  size: number,
  clientX: number,
  clientY: number,
  rect: DOMRect,
): BoardViewBox {
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportRight = viewportLeft + (visualViewport?.width ?? window.innerWidth);
  const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
  const visibleLeft = Math.max(rect.left, viewportLeft);
  const visibleTop = Math.max(rect.top, viewportTop);
  const visibleRight = Math.min(rect.right, viewportRight);
  const visibleBottom = Math.min(rect.bottom, viewportBottom);
  const insetX = Math.min(TIP_EDGE_INSET_PX, Math.max(0, (visibleRight - visibleLeft) / 2));
  const insetY = Math.min(TIP_EDGE_INSET_PX, Math.max(0, (visibleBottom - visibleTop) / 2));
  const desiredClientX = clamp(
    clientX + DESIRED_TIP_OFFSET_PX.x,
    visibleLeft + insetX,
    visibleRight - insetX,
  );
  const desiredClientY = clamp(
    clientY + DESIRED_TIP_OFFSET_PX.y,
    visibleTop + insetY,
    visibleBottom - insetY,
  );
  const desiredX = clamp((desiredClientX - rect.left) / rect.width, 0, 1);
  const desiredY = clamp((desiredClientY - rect.top) / rect.height, 0, 1);
  const furthestOrigin = SVG_SIZE - size;

  return {
    x: clamp(point.x - desiredX * size, 0, furthestOrigin),
    y: clamp(point.y - desiredY * size, 0, furthestOrigin),
    size,
  };
}

/** Move from the original tip by the finger's displacement, measured at precision scale. */
export function precisionTipAt(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  viewBox: BoardViewBox,
  origin: PrecisionOrigin,
): SvgPoint {
  const moved = {
    x: origin.tip.x + ((clientX - origin.clientX) / rect.width) * viewBox.size,
    y: origin.tip.y + ((clientY - origin.clientY) / rect.height) * viewBox.size,
  };
  return {
    x: clamp(moved.x, viewBox.x, viewBox.x + viewBox.size),
    y: clamp(moved.y, viewBox.y, viewBox.y + viewBox.size),
  };
}
