import { useCallback, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "blockrouter.theme";

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** "system" removes the attribute so the stylesheet follows the OS setting. */
export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const choose = useCallback((choice: ThemeChoice) => {
    applyTheme(choice);
    setTheme(choice);
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Storage unavailable; the choice lasts for this visit.
    }
  }, []);
  return [theme, choose];
}
