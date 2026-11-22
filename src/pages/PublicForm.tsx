import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import GlassCard from "@/components/GlassCard";
import type { FormConfig } from "@/lib/types";

export default function PublicForm() {
  const { slug } = useParams();
  const [config, setConfig] = useState<FormConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slug) return;
    void (async () => {
      try {
        const res = await fetch(`/api/form/${slug}`);
        if (!res.ok) throw new Error("Form not found");
        setConfig(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error loading form");
      }
    })();
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/form/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error("Submission failed");
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error submitting");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-lg">
        {error && !config && (
          <GlassCard className="text-center py-10">
            <p className="text-danger font-display text-lg">Form unavailable</p>
            <p className="text-muted mt-2 text-sm">{error}</p>
          </GlassCard>
        )}

        {config && !submitted && (
          <GlassCard className="p-8">
            <h1 className="page-title text-3xl mb-2">{config.title}</h1>
            {config.description && <p className="text-muted mb-6">{config.description}</p>}
            <form onSubmit={submit} className="flex flex-col gap-4">
              {config.fields.map((f, i) => {
                const fieldName = f.name?.trim() || `field_${i + 1}`;
                const inputType = f.type === "textarea" ? "textarea" : f.type || "text";
                return (
                  <div key={fieldName} className="flex flex-col gap-1.5">
                    <label className="text-xs text-fg2 font-display font-medium">
                      {f.label} {f.required && <span className="text-accent">*</span>}
                    </label>
                    {inputType === "textarea" ? (
                      <textarea
                        required={f.required}
                        rows={4}
                        className="bg-inset border border-line rounded-lg px-3 py-2.5 text-sm text-fg font-medium focus:outline-none focus:border-primary/60 focus: transition"
                        value={values[fieldName] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [fieldName]: e.target.value }))}
                      />
                    ) : (
                      <input
                        type={inputType}
                        required={f.required}
                        className="bg-inset border border-line rounded-lg px-3 py-2.5 text-sm text-fg font-medium focus:outline-none focus:border-primary/60 focus: transition"
                        value={values[fieldName] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [fieldName]: e.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
              <button
                type="submit"
                disabled={loading}
                className="mt-2 px-5 py-3 rounded-xl bg-gradient-to-r from-primary/80 to-primary/80 text-fg font-display text-sm disabled:opacity-60"
              >
                {loading ? "Submitting…" : "Submit"}
              </button>
            </form>
          </GlassCard>
        )}

        {submitted && (
          <GlassCard className="text-center py-12 flex flex-col items-center gap-4">
            <CheckCircle2 size={48} className="text-success" />
            <h2 className="font-display text-2xl">Got it.</h2>
            <p className="text-muted max-w-sm">An agent is already on it.</p>
          </GlassCard>
        )}
      </div>
    </div>
  );
}
