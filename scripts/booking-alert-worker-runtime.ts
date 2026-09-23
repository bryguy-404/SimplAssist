export function workerConfiguration(env: Record<string, string | undefined>) {
  const secret = env.OWNER_BOOKING_ALERTS_INTERNAL_TOKEN ?? '';
  if (secret.length < 32) throw new Error('OWNER_BOOKING_ALERTS_INTERNAL_TOKEN must have at least 32 characters');
  const origin = new URL(env.NEXT_PUBLIC_APP_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('NEXT_PUBLIC_APP_URL must be a canonical HTTPS origin');
  }
  return { secret, endpoint: new URL('/api/internal/booking-alerts/run', origin).toString(),
    recoveryEndpoint: new URL('/api/internal/booking-alerts/reconcile', origin).toString() };
}

/** Serial polling: a slow response never starts overlapping requests locally. */
export async function maintainBookingAlerts(
  config: ReturnType<typeof workerConfiguration>,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  return postMaintenance(config.endpoint, config.secret, fetcher);
}

export async function recoverBookingAlerts(
  config: ReturnType<typeof workerConfiguration>,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  return postMaintenance(config.recoveryEndpoint, config.secret, fetcher);
}

async function postMaintenance(endpoint: string, secret: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(55000),
      redirect: 'error',
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}
