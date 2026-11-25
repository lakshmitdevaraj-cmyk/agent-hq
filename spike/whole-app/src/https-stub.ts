// Stand-in for the one node:https use (HEAD request with certificate checking off). Nothing leaves the Worker.
import { ctx } from "./context";

export default {
  request(_opts: unknown, cb?: (res: { statusCode: number; resume: () => void }) => void) {
    const handlers: Record<string, (e?: unknown) => void> = {};
    ctx().outbound["node:https(stub)"] = (ctx().outbound["node:https(stub)"] ?? 0) + 1;
    const req = {
      on(name: string, fn: (e?: unknown) => void) { handlers[name] = fn; return req; },
      destroy() {},
      end() { queueMicrotask(() => (cb ? cb({ statusCode: 200, resume() {} }) : handlers.error?.(new Error("stub")))); },
    };
    return req;
  },
};
