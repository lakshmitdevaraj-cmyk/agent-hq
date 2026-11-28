/**
 * Actions removed in P2 chunk 12 (run F, 28 Nov 2026), on both backends. Their records were archived outside the repo
 * first (~/agent-hq-backups/p2-removals-2026-11-28/). command.ts answers each with 410 "removed", after the key check,
 * so a caller learns the feature is gone instead of "Unknown action".
 *   X1 Tasks · X2 Voice (the Gemini key lives in Settings) · X3 Pages (R5: the app serves no public HTML).
 * X8 (the old April forms) removed data, not actions: the form actions stay (A2).
 */
type ScopeId = "X1" | "X2" | "X3";
const FEATURE: Record<ScopeId, string> = { X1: "Tasks", X2: "Voice", X3: "Pages" };

const LIST: Record<ScopeId, string[]> = {
  X1: ["task.create", "task.list", "task.move", "task.delete", "outreach.replies.convert_to_task"],
  X2: [
    "voice.config.check", "voice.config.get", "voice.config.set", "voice.config.clear",
    "voice.session.save", "voice.session.list", "voice.session.get", "voice.session.delete",
    "voice.invitation.create", "voice.invitation.list", "voice.invitation.get", "voice.invitation.dismiss", "voice.invitation.accept",
  ],
  X3: ["page.create", "page.list", "page.get", "page.update", "page.delete"],
};

export const REMOVED: Record<string, { scope_id: ScopeId; feature: string }> = Object.fromEntries(
  (Object.keys(LIST) as ScopeId[]).flatMap((id) => LIST[id].map((a) => [a, { scope_id: id, feature: FEATURE[id] }])),
);

export type RemovedAnswer = { status: 410; code: "removed"; error: string; scope_id: ScopeId; feature: string };

/** The answer for a removed action, or null when the action is not one of them. */
export function removedAction(action: string): RemovedAnswer | null {
  const r = Object.prototype.hasOwnProperty.call(REMOVED, action) ? REMOVED[action] : null;
  if (!r) return null;
  const why = r.scope_id === "X2" ? " The Gemini key is set in Settings → API keys (config.set)." : "";
  return { status: 410, code: "removed", scope_id: r.scope_id, feature: r.feature, error: `${action} was removed: ${r.feature} is no longer part of Alcance (${r.scope_id}).${why}` };
}
