import { useEffect, useState } from "react";
import { getTheme, setTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Small three-way control. Auto follows the Mac's light/dark setting. */
export default function ThemeSwitch({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme());
  useEffect(() => {
    const sync = () => setChoice(getTheme());
    window.addEventListener("alcance-theme", sync);
    return () => window.removeEventListener("alcance-theme", sync);
  }, []);
  return (
    <div role="radiogroup" aria-label="Colour theme" className={cn("inline-flex rounded-lg border border-line bg-inset p-0.5", className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={choice === o.value}
          onClick={() => setTheme(o.value)}
          className={cn(
            "px-3 py-1 rounded-md text-label font-semibold transition",
            choice === o.value ? "bg-primary text-on-solid" : "text-fg2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
