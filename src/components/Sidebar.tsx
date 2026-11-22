import { NavLink } from "react-router-dom";
import {
  Building2,
  KanbanSquare,
  Activity as ActivityIcon,
  Users,
  Inbox as InboxIcon,
  Webhook,
  Code2,
  Mic,
  LayoutTemplate,
  Send,
  Settings as SettingsIcon,
  BarChart3,
  FormInput,
  Contact,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ThemeSwitch from "./ThemeSwitch";

const NAV = [
  { to: "/", label: "Office", icon: Building2, end: true },
  { to: "/tasks", label: "Tasks", icon: KanbanSquare },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/agents", label: "Agents", icon: Users },
  { to: "/voice", label: "Voice", icon: Mic },
  { to: "/outreach", label: "Outreach", icon: Send },
  { to: "/prospects", label: "Prospects", icon: Contact },
  { to: "/inbox", label: "Inbox", icon: InboxIcon },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/forms", label: "Forms", icon: FormInput },
  { to: "/pages", label: "Pages", icon: LayoutTemplate },
  { to: "/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/integrations", label: "Integrations", icon: Code2 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function Sidebar() {
  return (
    <aside className="w-[280px] shrink-0 border-r border-line px-5 py-8 flex flex-col gap-10">
      <Logo />
      <nav className="flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => cn("nav-pill", isActive && "active")}
          >
            <Icon size={18} strokeWidth={2} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3">
        <div>
          <p className="text-label text-fg2 mb-1.5 font-medium">Theme</p>
          <ThemeSwitch />
        </div>
        <div className="glass px-4 py-3">
          <p className="text-xs text-fg2 mb-1.5 font-display font-medium">Status</p>
          <div className="flex items-center gap-2">
            <span className="pulse-dot dot-green" />
            <span className="text-sm text-fg font-semibold">All systems operational</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Logo() {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-primary/15 border border-primary/40 flex items-center justify-center">
          <span className="font-display font-bold text-xl">A</span>
        </div>
              </div>
      <div className="text-center">
        <div className="font-display font-black tracking-[0.25em] text-lg">ALCANCE</div>
        <div className="text-label text-fg2 font-medium">Outreach</div>
      </div>
    </div>
  );
}
