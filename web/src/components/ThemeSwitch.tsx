import { type ThemeChoice, useTheme } from "../theme";
import { Icon, type IconName } from "./icons";

const OPTIONS: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

export function ThemeSwitch({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  return (
    <div className={`choices theme-switch ${className}`} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          aria-label={option.label}
          title={option.label}
          className={theme === option.value ? "choice active" : "choice"}
          onClick={() => setTheme(option.value)}
        >
          <Icon name={option.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
