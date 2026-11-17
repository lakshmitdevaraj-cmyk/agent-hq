import { useEffect, useRef } from "react";

/**
 * Run `fn` now, then every `ms` while the browser tab is visible.
 *
 * Every poll is a Netlify function call (they cost credits), so:
 *  - nothing runs while the tab is hidden;
 *  - when the tab becomes visible again it refreshes right away (if the data
 *    is at least `ms` old) and restarts the timer;
 *  - pages also give the user a manual refresh button for "now".
 * `deps` restarts the loop (e.g. when a route param changes).
 */
export function usePolling(fn: () => unknown, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let last = 0;
    const run = () => {
      last = Date.now();
      void ref.current();
    };
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!document.hidden) run();
      }, ms);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearInterval(timer);
        timer = null;
      } else {
        if (Date.now() - last >= ms) run();
        start();
      }
    };
    run();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
