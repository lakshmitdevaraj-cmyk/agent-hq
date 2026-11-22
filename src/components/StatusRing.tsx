import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/types";

const STATUS_STYLE: Record<AgentStatus, { ring: string; dot: string; label: string }> = {
  online: { ring: "", dot: "dot-green", label: "Online" },
  idle: { ring: "", dot: "dot-amber", label: "Idle" },
  offline: { ring: "", dot: "dot-gray", label: "Offline" },
  error: { ring: "", dot: "dot-red", label: "Error" },
};

type Props = {
  status: AgentStatus;
  size?: number;
  children?: React.ReactNode;
  className?: string;
};

export default function StatusRing({ status, size = 64, children, className }: Props) {
  const style = STATUS_STYLE[status];
  return (
    <div
      className={cn("relative rounded-full flex items-center justify-center", style.ring, className)}
      style={{ width: size, height: size }}
    >
      <div className="absolute inset-0 rounded-full border-2 border-line" />
      <div className="relative">{children}</div>
      <span className={cn("pulse-dot absolute -bottom-1 right-0", style.dot)} />
    </div>
  );
}

export function StatusLabel({ status }: { status: AgentStatus }) {
  return <span className="text-xs text-muted">{STATUS_STYLE[status].label}</span>;
}
