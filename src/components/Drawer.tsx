import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

type Props = { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; width?: string };

/**
 * A side panel: fixed header, body that scrolls on its own, 560-640 px wide on a laptop and full screen on a phone.
 * Long text wraps or is cut with a tooltip. Esc and a click outside close it. It does not lock the page behind it,
 * so the table, the filters and the scroll position stay as they were.
 */
export default function Drawer({ open, onClose, title, subtitle, children, width = "sm:w-[600px]" }: Props) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-inset" onClick={onClose} aria-hidden />
      <aside className={`absolute inset-y-0 right-0 w-full ${width} max-w-full bg-card border-l border-line shadow-2xl flex flex-col min-w-0 animate-fade-in`}>
        <header className="flex items-start gap-3 px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl font-bold break-words">{title}</h2>
            {subtitle && <p className="text-xs text-muted mt-0.5 break-words">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 text-muted hover:text-fg p-1" aria-label="Close"><X size={20} /></button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-4 break-words scroll-smooth [&_a]:break-all">{children}</div>
      </aside>
    </div>
  );
}
