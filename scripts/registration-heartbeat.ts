/** Independent of voice health: registration outages cannot stop live calls. */
export function createRegistrationHeartbeat(appUrl: URL, token: string, fetcher: typeof fetch = fetch) {
  let busy = false;
  let stopped = false;
  const shutdown = new AbortController();
  return {
    stop() { stopped = true; shutdown.abort(); },
    async run() {
      if (busy || stopped) return;
      busy = true;
      try {
        const response = await fetcher(new URL("/api/internal/onboarding/reconcile", appUrl), {
          method: "POST", headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(120_000)]),
        });
        if (!response.ok) console.warn("[registration] background check needs retry", { status: response.status });
      } catch {
        if (!stopped) console.warn("[registration] background check connection failed");
      } finally { busy = false; }
    },
  };
}
