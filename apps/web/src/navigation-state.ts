import type { InspectorTab, Surface } from "./domain";

export function surfaceAriaCurrent(active: Surface, candidate: Surface): "page" | undefined {
  return active === candidate ? "page" : undefined;
}

export function inspectorTabIsSelected(active: InspectorTab, candidate: InspectorTab): boolean {
  return active === candidate;
}
