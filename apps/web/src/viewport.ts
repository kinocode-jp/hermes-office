const PHONE_VIEWPORT = "(max-width: 768px)";

export function isPhoneViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia(PHONE_VIEWPORT).matches;
}
