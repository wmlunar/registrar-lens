(() => {
  const storageKey = "registrarlens-theme";
  let preference = "system";

  try {
    const stored = localStorage.getItem(storageKey);
    if (["system", "light", "dark"].includes(stored)) preference = stored;
  } catch (_) {
    preference = "system";
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
})();
