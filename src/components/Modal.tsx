import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidth?: string;
};

export default function Modal({ open, onClose, title, description, children, maxWidth = "max-w-xl" }: Props) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    // Fixed header, body that scrolls on its own (so the title and the close button never scroll away), and long words wrap
    // instead of pushing the pop-up wider than the screen. Esc and a click outside close it. Full screen on phones.
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:px-6 sm:py-8" role="dialog" aria-modal="true" aria-label={title}>
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className={`relative w-full ${maxWidth} glass animate-fade-in flex flex-col max-h-full sm:max-h-[calc(100vh-4rem)] rounded-none sm:rounded-2xl min-w-0`}>
        <div className="flex items-start gap-3 px-5 sm:px-7 pt-5 sm:pt-7 pb-3 border-b border-white/10 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl sm:text-2xl font-bold tracking-wide break-words">{title}</h2>
            {description && <p className="text-sm text-white/70 mt-1 font-medium break-words">{description}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 text-white/60 hover:text-white transition p-1" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="px-5 sm:px-7 py-4 sm:py-5 overflow-y-auto overflow-x-hidden min-h-0 flex-1 break-words scroll-smooth [&_table]:block [&_table]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">{children}</div>
      </div>
    </div>
  );
}

export function FormField({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-xs uppercase tracking-widest text-white/80 font-display font-bold">
        {label} {required && <span className="text-accent">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-white/55 font-medium">{hint}</p>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        "bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white font-medium placeholder:text-white/40 focus:outline-none focus:border-primary/60 focus:shadow-glow transition " +
        (props.className ?? "")
      }
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={
        "bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white font-medium placeholder:text-white/40 focus:outline-none focus:border-primary/60 focus:shadow-glow transition " +
        (props.className ?? "")
      }
    />
  );
}

export function PrimaryButton({
  children,
  loading,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={loading || rest.disabled}
      className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-primary hover:bg-primary/90 text-black font-display font-black tracking-widest text-sm uppercase shadow-glow transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? "Working..." : children}
    </button>
  );
}
