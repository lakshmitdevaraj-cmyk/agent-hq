import GlassCard from "./GlassCard";
import type { LucideIcon } from "lucide-react";

type Props = {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  accent?: "primary" | "accent" | "success" | "purple";
  sub?: string;
};

const ACCENT_MAP = {
  primary: "text-primary",
  accent: "text-accent",
  success: "text-success",
  purple: "text-primary",
};

export default function MetricCard({ label, value, icon: Icon, accent = "primary", sub }: Props) {
  return (
    <GlassCard hover className="relative min-w-0 !p-5">
      <div className="flex items-center gap-2 text-fg2 text-label font-display font-medium">
        {Icon && <Icon size={14} className={ACCENT_MAP[accent]} strokeWidth={2.5} />}
        {label}
      </div>
      <div className="stat-num mt-3">{value}</div>
      {sub && <div className="text-muted text-sm mt-2 font-semibold">{sub}</div>}
    </GlassCard>
  );
}
