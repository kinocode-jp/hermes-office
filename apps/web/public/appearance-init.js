(() => {
  const fallback = { theme: "paper", fontScale: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem("hermes-office:appearance:v1") || "null") || fallback;
    const theme = ["paper", "mint", "midnight"].includes(saved.theme) ? saved.theme : fallback.theme;
    const fontScale = [0.9, 1, 1.1, 1.2].includes(saved.fontScale) ? saved.fontScale : fallback.fontScale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontScale = String(fontScale).replace(".", "-");
    document.documentElement.style.colorScheme = theme === "midnight" ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = fallback.theme;
    document.documentElement.dataset.fontScale = "1";
  }
})();
