const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

export function hasOpenModal(except?: HTMLElement | null): boolean {
  return [...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)].some((modal) => modal !== except);
}

export function isTopmostModal(modal?: HTMLElement | null): boolean {
  if (!modal) return false;
  const modals = [...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)];
  return modals.at(-1) === modal;
}
