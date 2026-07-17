(() => {
  const fallback = { theme: "paper", fontScale: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem("hermes-office:appearance:v1") || "null") || fallback;
    const theme = ["paper", "mint", "midnight"].includes(saved.theme) ? saved.theme : fallback.theme;
    const legacyFontScales = new Map([[0.9, 1], [1.1, 1.125], [1.2, 1.25]]);
    const fontScale = [1, 1.125, 1.25, 1.5].includes(saved.fontScale)
      ? saved.fontScale
      : legacyFontScales.get(saved.fontScale) || fallback.fontScale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontScale = String(fontScale).replace(".", "-");
    document.documentElement.style.setProperty("--font-scale", String(fontScale));
    document.documentElement.style.colorScheme = theme === "midnight" ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = fallback.theme;
    document.documentElement.dataset.fontScale = "1";
    document.documentElement.style.setProperty("--font-scale", "1");
    document.documentElement.style.colorScheme = "light";
  }
})();
