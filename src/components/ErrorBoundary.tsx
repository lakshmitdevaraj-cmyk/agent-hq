import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; /** What broke, shown to the user. */ label?: string; /** Smaller message for one card in a list. */ compact?: boolean; /** Change this to try again (the router location, a card id). */ resetKey?: string };
type State = { error: Error | null; key?: string };

/** One broken card or page shows a message instead of taking the whole screen down. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }
  componentDidCatch(error: Error) { console.error("[ErrorBoundary]", error); }
  render() {
    if (!this.state.error) return this.props.children;
    const what = this.props.label ?? "This part";
    return (
      <div role="alert" className={`rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 ${this.props.compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"}`}>
        {what} could not be shown ({this.state.error.message}). The rest of the page still works. Reload to try again.
      </div>
    );
  }
}

/** Calls `render` inside the boundary, so an error thrown while building one item is caught here and not by the whole page. */
function Inner({ render }: { render: () => ReactNode }) { return <>{render()}</>; }
export function SafeItem({ render, label, id }: { render: () => ReactNode; label: string; id: string }) {
  return <ErrorBoundary compact label={label} resetKey={id}><Inner render={render} /></ErrorBoundary>;
}
