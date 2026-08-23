/**
 * Wait until `condition` returns a truthy value, checking on each animation
 * frame (or via setTimeout fallback). Resolves with the condition result.
 */
export function waitFor<T>(
  condition: () => T | false | undefined | null,
  timeout: number = 10000,
  interval: number = 50,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        const r = condition();
        if (r) {
          resolve(r);
          return;
        }
      } catch (e) {
        // ignore, keep waiting
      }
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timeout after ${timeout}ms`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}
