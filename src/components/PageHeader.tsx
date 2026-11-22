import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
};

export default function PageHeader({ title, subtitle, right }: Props) {
  return (
    <div className="flex flex-wrap items-end justify-between mb-8 gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="text-fg2 mt-3 max-w-2xl font-medium">{subtitle}</p>}
      </div>
      {right && <div className="min-w-0 max-w-full [&>div]:flex-wrap">{right}</div>}
    </div>
  );
}
