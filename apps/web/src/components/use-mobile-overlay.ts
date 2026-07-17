import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const MOBILE_VIEWPORT = "(max-width: 767px)";
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type MobileOverlayOptions = {
  kind: "modal" | "route";
  open: boolean;
  onClose(): void;
};

export function useMobileOverlay<T extends HTMLElement>({ kind, open, onClose }: MobileOverlayOptions) {
  const [overlayElement, setOverlayElement] = useState<T | null>(null);
  const ref = useCallback((element: T | null) => setOverlayElement(element), []);
  const closeRef = useRef(onClose);
  const [mobileViewport, setMobileViewport] = useState(isMobileViewport);
  closeRef.current = onClose;

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(MOBILE_VIEWPORT);
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const active = open && mobileViewport;
  useEffect(() => {
    const overlay = overlayElement;
    if (!active || !overlay) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlayRoot = overlay.closest<HTMLElement>(".profile-panel, .workspace-drawer") ?? overlay;
    const appShell = overlayRoot.closest<HTMLElement>(".app-shell");
    const background = appShell
      ? [...appShell.children].filter((element): element is HTMLElement => (
        element instanceof HTMLElement
        && element !== overlayRoot
        && (kind !== "route" || !element.hasAttribute("data-mobile-route-chrome"))
      ))
      : [];
    const previousBackground = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      const initial = overlay.querySelector<HTMLElement>("[data-mobile-overlay-initial-focus]")
        ?? focusableElements(overlay)[0]
        ?? overlay;
      initial.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const nestedModal = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
        : null;
      if (nestedModal && nestedModal !== overlay) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (kind !== "modal" || event.key !== "Tab") return;
      const focusable = focusableElements(overlay);
      if (focusable.length === 0) {
        event.preventDefault();
        overlay.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    overlay.addEventListener("keydown", handleKeyDown);

    return () => {
      disposed = true;
      overlay.removeEventListener("keydown", handleKeyDown);
      const shouldRestoreFocus = overlay.contains(document.activeElement);
      for (const { element, inert, ariaHidden } of previousBackground) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (shouldRestoreFocus && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, kind, overlayElement]);

  return { ref, active };
}

function isMobileViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia(MOBILE_VIEWPORT).matches;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}
