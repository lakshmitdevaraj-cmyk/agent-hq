import { useState } from "react";
import Modal, { FormField, TextInput, TextArea, PrimaryButton } from "./Modal";
import { call } from "@/lib/api";
import type { Webhook } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (webhook: Webhook) => void;
};

export default function NewWebhookModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const webhook = await call<Webhook>("webhook.create", {
        name: name.trim(),
        description: description.trim(),
      });
      onCreated(webhook);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setName("");
    setDescription("");
    setError(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create New Webhook"
      description="A catch-all public URL you can paste into Cal.com, Stripe, GitHub, Zapier — anything. Every event lands in the activity log."
    >
      <form onSubmit={submit} className="flex flex-col">
        <FormField label="Name" required hint="Shows up as the webhook's label on the Webhooks page.">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cal.com Bookings, Stripe Payments..."
            required
          />
        </FormField>

        <FormField label="Description" hint="What the webhook is for — helps agents pick the right one.">
          <TextArea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Every new booking triggers Atlas to prep a briefing."
          />
        </FormField>

        {error && <p className="text-sm text-danger font-semibold mb-3">{error}</p>}

        <div className="flex items-center gap-3 mt-2">
          <PrimaryButton type="submit" loading={loading}>
            Create Webhook
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
