type ModalEntry = { sequence: number };

const modalStack = new Map<HTMLElement, ModalEntry>();
const backgroundLocks = new Map<HTMLElement, { count: number; inert: boolean; ariaHidden: string | null }>();
let openSequence = 0;
let releaseModalBackground: (() => void) | undefined;
let backgroundModal: HTMLElement | undefined;

export function registerModal(modal: HTMLElement): () => void {
  const sequence = ++openSequence;
  modalStack.set(modal, { sequence });
  reconcileModalBackground();
  return () => {
    if (modalStack.get(modal)?.sequence !== sequence) return;
    modalStack.delete(modal);
    reconcileModalBackground();
  };
}

export function hasOpenModal(except?: HTMLElement | null): boolean {
  refreshModalStack();
  return [...modalStack].some(([modal]) => modal !== except);
}

export function isTopmostModal(modal?: HTMLElement | null): boolean {
  if (!modal) return false;
  refreshModalStack();
  return topModal()?.[0] === modal;
}

export function canRestoreModalFocus(target?: HTMLElement | null): boolean {
  if (!target?.isConnected) return false;
  refreshModalStack();
  const top = topModal()?.[0];
  return top === undefined || top.contains(target);
}

export function modalDisplayLayer(modal: HTMLElement): number[] {
  if (typeof getComputedStyle !== "function") return [0];
  const layers: number[] = [];
  for (let node: HTMLElement | null = modal; node; node = node.parentElement) {
    try {
      const value = getComputedStyle(node).zIndex;
      if (/^-?\d+$/.test(value)) layers.push(Number(value));
    } catch {
      return [0];
    }
  }
  return layers.length > 0 ? layers.reverse() : [0];
}

export function lockBackgroundElements(background: readonly HTMLElement[]): () => void {
  for (const element of background) {
    const lock = backgroundLocks.get(element);
    if (lock) lock.count += 1;
    else {
      backgroundLocks.set(element, { count: 1, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") });
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
  }
  return () => {
    for (const element of background) {
      const lock = backgroundLocks.get(element);
      if (!lock || --lock.count > 0) continue;
      backgroundLocks.delete(element);
      element.inert = lock.inert;
      if (lock.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", lock.ariaHidden);
    }
  };
}

function refreshModalStack(): void {
  let changed = false;
  for (const modal of modalStack.keys()) {
    if (modal.isConnected === false) {
      modalStack.delete(modal);
      changed = true;
    }
  }
  if (changed || topModal()?.[0] !== backgroundModal) reconcileModalBackground();
}

function topModal(): [HTMLElement, ModalEntry] | undefined {
  return [...modalStack].sort((left, right) => compareModalEntries(right, left))[0];
}

function compareModalEntries(
  [leftModal, left]: [HTMLElement, ModalEntry],
  [rightModal, right]: [HTMLElement, ModalEntry],
): number {
  const leftLayer = modalDisplayLayer(leftModal);
  const rightLayer = modalDisplayLayer(rightModal);
  const length = Math.max(leftLayer.length, rightLayer.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftLayer[index] ?? 0) - (rightLayer[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.sequence - right.sequence;
}

function reconcileModalBackground(): void {
  releaseModalBackground?.();
  releaseModalBackground = undefined;
  const top = topModal()?.[0];
  backgroundModal = top;
  if (top) releaseModalBackground = lockBackgroundElements(modalBackgroundElements(top));
}

function modalBackgroundElements(modal: HTMLElement): HTMLElement[] {
  if (typeof modal.closest !== "function") return [];
  const background = new Set<HTMLElement>();
  let current = modal.closest<HTMLElement>("[data-modal-root]") ?? modal;
  while (current.parentElement) {
    const parent = current.parentElement;
    for (const sibling of parent.children) {
      if (sibling instanceof HTMLElement && sibling !== current && sibling.dataset.modalAffordance !== "true") {
        background.add(sibling);
      }
    }
    if (parent.matches(".app-shell") || (typeof document !== "undefined" && parent === document.body)) break;
    current = parent;
  }
  return [...background];
}
