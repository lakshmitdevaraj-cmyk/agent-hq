import { usePolling } from "@/lib/usePolling";
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import TaskQuickAdd from "@/components/TaskQuickAdd";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "@/lib/types";

const COLUMNS: { status: TaskStatus; label: string; accent: string }[] = [
  { status: "todo", label: "To Do", accent: "from-white/10 to-white/0" },
  { status: "doing", label: "Doing", accent: "from-primary/25 to-primary/0" },
  { status: "needs_input", label: "Needs Input", accent: "from-amber/25 to-amber/0" },
  { status: "canceled", label: "Canceled", accent: "from-danger/20 to-danger/0" },
  { status: "done", label: "Done", accent: "from-success/25 to-success/0" },
];

const SEED: Task[] = [
  { id: "1", title: "Research Acme Corp before Thursday demo", description: null, status: "doing", assignee_id: null, priority: "high", created_at: "", updated_at: "" },
  { id: "2", title: "Draft launch announcement email", description: null, status: "todo", assignee_id: null, priority: "medium", created_at: "", updated_at: "" },
  { id: "3", title: "Approve new onboarding copy", description: null, status: "needs_input", assignee_id: null, priority: "high", created_at: "", updated_at: "" },
  { id: "4", title: "Summarize last 3 sales calls", description: null, status: "done", assignee_id: null, priority: "low", created_at: "", updated_at: "" },
  { id: "5", title: "Qualify 12 inbound leads from form", description: null, status: "doing", assignee_id: null, priority: "medium", created_at: "", updated_at: "" },
];

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  usePolling(refresh, 30000, []);

  async function refresh() {
    try {
      const list = await call<Task[]>("task.list");
      setTasks(list);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }

  const display = tasks.length > 0 ? tasks : loaded ? [] : SEED;

  const grouped = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c.status, [] as Task[]]));
    for (const t of display) map[t.status]?.push(t);
    return map;
  }, [display]);

  function handleAdded(task: Task) {
    setTasks((prev) => [task, ...prev]);
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const taskId = String(e.active.id);
    const over = e.over;
    if (!over) return;
    const newStatus = String(over.id) as TaskStatus;
    const existing = display.find((t) => t.id === taskId);
    if (!existing || existing.status === newStatus) return;

    // Optimistic
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)),
    );
    try {
      await call("task.move", { id: taskId, status: newStatus });
    } catch {
      // Rollback on failure — ignore for seed-only tasks
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: existing.status } : t)),
      );
    }
  }

  const activeTask = display.find((t) => t.id === activeId) ?? null;

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="Every card is work your agents are doing — or waiting on you for. Drag cards to move them."
      />

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-5 gap-4">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.status}
              status={col.status}
              label={col.label}
              accent={col.accent}
              count={grouped[col.status]?.length ?? 0}
            >
              {col.status === "todo" && <TaskQuickAdd onAdded={handleAdded} />}
              {grouped[col.status]?.map((t) => (
                <DraggableTaskCard key={t.id} task={t} />
              ))}
            </KanbanColumn>
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask && <TaskCard task={activeTask} dragging />}
        </DragOverlay>
      </DndContext>
    </>
  );
}

function KanbanColumn({
  status,
  label,
  accent,
  count,
  children,
}: {
  status: TaskStatus;
  label: string;
  accent: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("glass p-3 bg-gradient-to-b", accent)}>
        <div className="flex items-center justify-between">
          <span className="font-display text-xs tracking-widest uppercase text-white font-bold">
            {label}
          </span>
          <span className="text-xs text-white/70 font-mono font-bold">{count}</span>
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex flex-col gap-3 min-h-[200px] rounded-xl p-1.5 transition",
          isOver && "bg-primary/[0.06] ring-2 ring-primary/40 ring-offset-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function DraggableTaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "opacity-40")}
    >
      <TaskCard task={task} />
    </div>
  );
}

function TaskCard({ task, dragging }: { task: Task; dragging?: boolean }) {
  const priorityColor =
    task.priority === "high" ? "bg-danger" : task.priority === "medium" ? "bg-primary" : "bg-white/50";
  return (
    <GlassCard
      hover
      className={cn(
        "p-4 cursor-grab active:cursor-grabbing",
        dragging && "ring-2 ring-primary shadow-glow rotate-1",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("w-1.5 h-1.5 rounded-full mt-2 shrink-0", priorityColor)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white font-medium leading-snug">{task.title}</p>
          <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/65 font-bold">
            <span>{task.priority}</span>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
