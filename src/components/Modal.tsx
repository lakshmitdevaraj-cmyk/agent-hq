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
    // The whole overlay scrolls, so a tall form (like Generate emails) can always
    // be scrolled to its buttons instead of being clipped by the window.
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex min-h-full items-center justify-center px-6 py-8">
      <div className={`relative w-full ${maxWidth} glass p-7 animate-fade-in`}>
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/60 hover:text-white transition"
          aria-label="Close"
        >
          <X size={20} />
        </button>
        <h2 className="font-display text-2xl font-bold tracking-wide mb-1">{title}</h2>
        {description && <p className="text-sm text-white/70 mb-5 font-medium">{description}</p>}
        {children}
      </div>
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
