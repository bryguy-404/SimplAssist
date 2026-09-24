import {
  OWNER_BOOKING_ALERT_CONSENT_VERSION,
  ownerBookingAlertSettingsSchema,
  type OwnerBookingAlertMutation,
  type OwnerBookingAlertSettings,
} from '@/lib/owner-booking-alerts/contracts';

export type BookingAlertUpdate = OwnerBookingAlertMutation;

export class BookingAlertRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BookingAlertRequestError';
  }
}

async function request(
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<OwnerBookingAlertSettings> {
  let response: Response;
  try {
    response = await fetcher('/api/settings/booking-alerts', { ...init, cache: 'no-store' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new BookingAlertRequestError('Could not reach business alerts. Please try again.', 0);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body ? body.code : null;
    const message = code === 'phone_not_mobile'
      ? 'Enter a US mobile number that can receive texts.'
      : code === 'phone_reserved'
        ? 'Use your own mobile number, not a SimplAssist assistant number.'
      : response.status === 409
      ? 'Business alert settings changed. Refresh and review them before trying again.'
      : response.status === 429
        ? 'Please wait a few minutes before requesting another verification text.'
        : response.status === 400
          ? 'Check your mobile number and consent, then try again.'
          : response.status === 403
            ? 'Business alerts are not available with your current access.'
            : 'Business alerts are temporarily unavailable. Please try again.';
    throw new BookingAlertRequestError(message, response.status);
  }
  const parsed = ownerBookingAlertSettingsSchema.safeParse(
    body && typeof body === 'object' && 'alerts' in body ? body.alerts : null,
  );
  if (!parsed.success || parsed.data.consentVersion !== OWNER_BOOKING_ALERT_CONSENT_VERSION) throw new BookingAlertRequestError('Business alert settings could not be verified. Please refresh.', 0);
  return parsed.data;
}

export function loadBookingAlerts(signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  return request({ method: 'GET', signal }, fetcher);
}

export function updateBookingAlerts(update: BookingAlertUpdate, fetcher: typeof fetch = fetch) {
  return request({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) }, fetcher);
}

export function shouldShowBookingAlertNudge(settings: OwnerBookingAlertSettings | null): boolean {
  return Boolean(settings?.available && settings.eligible && !settings.enabled &&
    !settings.recipient && !settings.pendingRecipient && !settings.nudgeDismissedAt);
}

export const BOOKING_ALERT_POLL_INTERVAL_MS = 3_000;
export const BOOKING_ALERT_POLL_LIMIT = 30;

export function canPollVerification(expiresAt: string, attempts: number, now = Date.now()): boolean {
  return attempts < BOOKING_ALERT_POLL_LIMIT && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now;
}
