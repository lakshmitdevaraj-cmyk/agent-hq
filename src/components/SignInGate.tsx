import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { call, clearApiKey, setApiKey, SIGNIN_EVENT } from "@/lib/api";

/**
 * Full-screen "paste your API key" prompt. Shown when the server says this
 * browser has no (valid) key. The key is the one on the Integrations page of a
 * browser that is already signed in.
 */
export default function SignInGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SIGNIN_EVENT, show);
    return () => window.removeEventListener(SIGNIN_EVENT, show);
  }, []);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    setErr(null);
    setApiKey(key);
    try {
      await call("config.status"); // any authenticated call proves the key
      window.location.reload();
    } catch {
      clearApiKey();
      setErr("That key was not accepted. Copy it again from Integrations on a signed-in browser.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0b1020] p-6">
        <div className="flex items-center gap-3 mb-2">
          <KeyRound size={20} className="text-primary" />
          <h2 className="font-display text-xl font-bold text-white">Sign in</h2>
        </div>
        <p className="text-sm text-white/65 mb-4">
          Paste your ShiftForge HQ API key. You can copy it from the Integrations page in a browser that is already signed in.
        </p>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ahq_…"
          className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/15 text-white text-sm font-mono focus:outline-none focus:border-primary/60"
        />
        {err && <div className="text-xs text-red-300 mt-2">{err}</div>}
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-sm font-bold transition disabled:opacity-40"
        >
          {busy && <Loader2 size={14} className="animate-spin" />} Sign in
        </button>
      </form>
    </div>
  );
}
