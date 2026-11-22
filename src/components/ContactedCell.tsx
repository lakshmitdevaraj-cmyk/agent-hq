import { Mail, Facebook, Instagram, Linkedin } from "lucide-react";
import { contactedDetail, dayMonth, type Prospect } from "@/lib/prospects";

const CHIPS = [
  { key: "email", label: "Email", Icon: Mail },
  { key: "facebook", label: "Facebook", Icon: Facebook },
  { key: "instagram", label: "Instagram", Icon: Instagram },
  { key: "linkedin", label: "LinkedIn", Icon: Linkedin },
] as const;

/** Prospects "Contacted" column: one chip per contacted channel (icon + count), a green Replied tag, and "Last sent". Two lines at most, fixed width. */
export default function ContactedCell({ r }: { r: Prospect }) {
  const t = r.touches;
  const ready = (r.social_drafts ?? []).length;
  const detail = contactedDetail(r);
  if (!t || (t.total === 0 && !t.replied)) {
    return <div className="w-[300px] text-fg2" title={detail}>Not contacted{ready > 0 && <span className="tag tag-info ml-2" title="A social message is ready to send">{ready} ready</span>}</div>;
  }
  return (
    <div className="w-[300px] leading-tight" title={detail} aria-label={detail}>
      <div className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
        {CHIPS.filter((c) => t.counts[c.key] > 0).map(({ key, label, Icon }) => (
          <span key={key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-line bg-inset text-fg text-label font-semibold">
            <Icon size={13} aria-hidden="true" /><span className="sr-only">{label}: </span>{t.counts[key]}<span className="sr-only"> sent</span>
          </span>
        ))}
        {t.replied && <span className="tag tag-ok">Replied{t.replied_at ? ` ${dayMonth(t.replied_at)}` : ""}</span>}
      </div>
      <div className="mt-1 flex items-center gap-2 whitespace-nowrap overflow-hidden text-label text-fg2">
        {t.last_at ? <span>Last sent: {dayMonth(t.last_at)}</span> : <span>Not contacted by HQ</span>}
        {ready > 0 && <span className="tag tag-info" title="A social message is ready to send">{ready} ready</span>}
      </div>
    </div>
  );
}
