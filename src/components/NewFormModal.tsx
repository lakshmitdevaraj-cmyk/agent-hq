import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import Modal, { FormField, TextInput, TextArea, PrimaryButton } from "./Modal";
import { call } from "@/lib/api";
import type { FormConfig } from "@/lib/types";

type Field = { name: string; label: string; type: "text" | "email" | "textarea"; required: boolean };

const DEFAULT_FIELDS: Field[] = [
  { name: "name", label: "Full Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (form: FormConfig) => void;
};

export default function NewFormModal({ open, onClose, onCreated }: Props) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<Field[]>(DEFAULT_FIELDS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField(i: number, patch: Partial<Field>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  function addField() {
    setFields((prev) => [...prev, { name: "", label: "", type: "text", required: false }]);
  }

  function removeField(i: number) {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim() || !title.trim() || fields.length === 0) return;
    const validFields = fields.filter((f) => f.name.trim() && f.label.trim());
    if (validFields.length === 0) {
      setError("Add at least one field with a name and label");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const form = await call<FormConfig>("form.create", {
        slug: slug.trim(),
        title: title.trim(),
        description: description.trim(),
        fields: validFields,
      });
      onCreated(form);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create form");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setSlug("");
    setTitle("");
    setDescription("");
    setFields(DEFAULT_FIELDS);
    setError(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create New Form"
      description="Public URL. Anyone can submit. Every submission lands in the activity log for an agent to pick up."
      maxWidth="max-w-2xl"
    >
      <form onSubmit={submit} className="flex flex-col">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Slug" required hint="URL path — only letters, numbers, dashes">
            <TextInput
              autoFocus
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
              }
              placeholder="lead-intake"
              required
            />
          </FormField>
          <FormField label="Title" required>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New Lead Intake"
              required
            />
          </FormField>
        </div>

        <FormField label="Description">
          <TextArea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this form is for."
          />
        </FormField>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-fg2 font-display font-medium">
              Fields
            </span>
            <button
              type="button"
              onClick={addField}
              className="flex items-center gap-1.5 text-xs text-primary hover:text-primary font-medium"
            >
              <Plus size={14} strokeWidth={2.5} /> Add Field
            </button>
          </div>
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
            {fields.map((f, i) => (
              <div key={i} className="glass p-3 flex items-center gap-2">
                <TextInput
                  value={f.name}
                  onChange={(e) =>
                    updateField(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })
                  }
                  placeholder="name"
                  className="w-28 shrink-0"
                />
                <TextInput
                  value={f.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}
                  placeholder="Full Name"
                  className="flex-1 min-w-0"
                />
                <select
                  value={f.type}
                  onChange={(e) => updateField(i, { type: e.target.value as Field["type"] })}
                  className="bg-inset border border-line rounded-lg px-2 py-2.5 text-sm text-fg font-medium focus:outline-none focus:border-primary/60"
                >
                  <option value="text">text</option>
                  <option value="email">email</option>
                  <option value="textarea">textarea</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-fg2 font-medium shrink-0">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => updateField(i, { required: e.target.checked })}
                    className="accent-primary"
                  />
                  Req
                </label>
                <button
                  type="button"
                  onClick={() => removeField(i)}
                  className="text-muted hover:text-danger transition shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-danger font-semibold mb-3">{error}</p>}

        <div className="flex items-center gap-3 mt-2">
          <PrimaryButton type="submit" loading={loading}>
            Create Form
          </PrimaryButton>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="px-4 py-3 text-sm text-fg2 hover:text-fg font-display font-medium"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
