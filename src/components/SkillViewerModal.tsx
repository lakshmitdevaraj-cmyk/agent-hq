import { useState } from "react";
import { Copy, CheckCheck, Sparkles, FileText } from "lucide-react";
import Modal from "./Modal";
import { copyToClipboard } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  skillMarkdown: string;
};

export default function SkillViewerModal({ open, onClose, title, description, skillMarkdown }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyToClipboard(skillMarkdown);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } else {
      alert("Clipboard blocked. Select the skill text below and copy manually.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} maxWidth="max-w-5xl">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void copy()}
            className={`flex items-center gap-2 px-5 py-3 rounded-xl font-display font-black tracking-widest text-sm uppercase transition ${
              copied
                ? "bg-success text-on-solid"
                : "bg-primary text-on-solid hover:bg-primary/90"
            }`}
          >
            {copied ? <CheckCheck size={16} strokeWidth={3} /> : <Copy size={16} strokeWidth={3} />}
            {copied ? "Copied — paste into your agent" : "Copy Skill"}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-fg2 font-medium">
            <FileText size={13} strokeWidth={2.5} />
            Markdown · paste into SKILL.md or your agent's system prompt
          </div>
        </div>

        <div className="glass bg-inset border-line max-h-[60vh] overflow-y-auto">
          <pre className="font-mono text-xs text-fg p-5 leading-relaxed whitespace-pre-wrap">
            {skillMarkdown}
          </pre>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted font-medium">
          <Sparkles size={13} className="text-accent" strokeWidth={2.3} />
          Works with OpenClaw, Claude Code, Hermes, Minimax, Gemini, ChatGPT, or any agent runtime.
        </div>
      </div>
    </Modal>
  );
}
