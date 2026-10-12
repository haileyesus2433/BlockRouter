import { useEffect, useState } from "react";

import { useTheme } from "../theme";
import { Icon } from "./icons";

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Flips between light and dark; until clicked, the theme follows the system setting. */
export function ThemeSwitch({ className = "icon-button" }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);
  useEffect(() => {
    const query = darkQuery();
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button className={className} onClick={() => setTheme(dark ? "light" : "dark")} aria-label={label} title={label}>
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
