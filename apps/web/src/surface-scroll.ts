import type { Surface } from "./domain";

export type SurfaceScrollPosition = Readonly<{ top: number; left: number }>;
export type SurfaceScrollTarget = Pick<HTMLElement, "scrollTop" | "scrollLeft">;

export function rememberSurfaceScroll(
  positions: Map<Surface, SurfaceScrollPosition>,
  surface: Surface,
  target: SurfaceScrollTarget,
): void {
  positions.set(surface, { top: target.scrollTop, left: target.scrollLeft });
}

export function restoreSurfaceScroll(
  positions: ReadonlyMap<Surface, SurfaceScrollPosition>,
  surface: Surface,
  target: SurfaceScrollTarget,
): void {
  const position = positions.get(surface);
  target.scrollTop = position?.top ?? 0;
  target.scrollLeft = position?.left ?? 0;
}
