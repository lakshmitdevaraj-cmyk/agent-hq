import { Mail, Facebook, Instagram, Linkedin } from "lucide-react";
import { contactedDetail, dayMonth, type Prospect } from "@/lib/prospects";

const CHIPS = [
  { key: "email", label: "Email", Icon: Mail },
  { key: "facebook", label: "Facebook", Icon: Facebook },
  { key: "instagram", label: "Instagram", Icon: Instagram },
  { key: "linkedin", label: "LinkedIn", Icon: Linkedin },
] as const;

/**
 * Prospects "Contacted" column: one chip per contacted channel (icon + sent count; Email is a chip like the others),
 * a Replied tag, Bounced / Do not contact tags, and "Last sent". Two lines at most, fixed width.
 * A lead never contacted on any channel shows "Not contacted".
 */
export default function ContactedCell({ r }: { r: Prospect }) {
  const t = r.touches;
  const ready = (r.social_drafts ?? []).length;
  const CHAN: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
  const readyText = [...new Set((r.social_drafts ?? []).map((d) => CHAN[d.channel] ?? d.channel))].join(", ");
  const detail = contactedDetail(r);
  const emailSent = Math.max(t?.counts.email ?? 0, r.email_status === "emailed" || r.email_status === "replied" ? 1 : 0);
  const replied = !!t?.replied || r.email_status === "replied";
  const bounced = r.email_status === "bounced";
  const dnc = r.email_status === "do_not_contact";
  const any = (t?.total ?? 0) > 0 || emailSent > 0 || replied || bounced || dnc;
  if (!any) {
    return <div className="w-[300px] text-fg2" title={detail}>Not contacted{ready > 0 && <span className="text-label text-fg2"> · {readyText} message{ready === 1 ? "" : "s"} ready</span>}</div>;
  }
  const counts = { email: emailSent, facebook: t?.counts.facebook ?? 0, instagram: t?.counts.instagram ?? 0, linkedin: t?.counts.linkedin ?? 0 };
  const last = t?.last_at ?? r.emailed_at ?? null;
  return (
    <div className="w-[300px] leading-tight" title={detail} aria-label={detail}>
      <div className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
        {CHIPS.filter((c) => counts[c.key] > 0).map(({ key, label, Icon }) => (
          <span key={key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-line bg-inset text-fg text-label font-semibold">
            <Icon size={13} aria-hidden="true" /><span className="sr-only">{label}: </span>{counts[key]}<span className="sr-only"> sent</span>
          </span>
        ))}
        {replied && <span className="tag tag-ok">Replied{t?.replied_at ? ` ${dayMonth(t.replied_at)}` : ""}</span>}
        {bounced && <span className="tag tag-bad">Bounced</span>}
        {dnc && <span className="tag tag-bad">Do not contact</span>}
      </div>
      <div className="mt-1 flex items-center gap-2 whitespace-nowrap overflow-hidden text-label text-fg2">
        {last ? <span>Last sent: {dayMonth(last)}</span> : <span>Not contacted by HQ</span>}
        {ready > 0 && <span className="tag tag-info" title="A social message is ready to send">{readyText} ready</span>}
      </div>
    </div>
  );
}
