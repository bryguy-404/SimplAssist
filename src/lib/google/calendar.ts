import { validateVoiceBookingAccess, VoiceBookingNotSubmittedError, type VoiceBookingAuthority } from "@/lib/voice/bookingAccess.server";
import { createHash, randomUUID } from "node:crypto";
import type { calendar_v3 } from "googleapis";
import { getAuthenticatedClient, getCalendarService } from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { BusinessHours } from "@/types/database";
import {
  canUseFeature,
  resolveBusinessEntitlements
} from "@/lib/billing/entitlements";
import {
  assertBookingOperationallyAllowed,
  BookingOperationalStateError,
  isBookingOperationalBlockedError
} from "./bookingOperational.server";
import { businessWallTimeToInstant } from "./calendarTime";
import { normalizeKnowledgeKey } from "@/lib/contentQuality";
import { normalizeEmail } from "@/lib/leads/classification";

const SLOT_DURATION_MINUTES = 30;
const MAX_BOOKING_DURATION_MINUTES = 240;
const DEFAULT_BOOKING_MIN_LEAD_MINUTES = 60;
const DEFAULT_BOOKING_MAX_HORIZON_DAYS = 90;
const MAX_CONFIGURED_LEAD_MINUTES = 30 * 24 * 60;
const MAX_CONFIGURED_HORIZON_DAYS = 365;
const MAX_CUSTOMER_NAME_LENGTH = 200;
const MAX_SERVICE_NAME_LENGTH = 200;
const MAX_CUSTOMER_PHONE_LENGTH = 50;
const MAX_CUSTOMER_EMAIL_LENGTH = 254;
const MAX_START_TIME_LENGTH = 64;
const MAX_TIMEZONE_LENGTH = 100;
const CALENDAR_AVAILABILITY_TIMEOUT_MS = 10_000;
const CALENDAR_MUTATION_TIMEOUT_MS = 60_000;
const CALENDAR_RECOVERY_TIMEOUT_MS = 10_000;
const CALENDAR_CREDENTIAL_TIMEOUT_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/;
const CREATE_BOOKING_TIMEZONE_ERROR =
  "A valid IANA business timezone is required to create a booking.";

interface BookingWindowPolicy {
  minimumLeadMinutes: number;
  maximumHorizonDays: number;
}

interface BusinessLocalParts {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

interface ActiveServiceRow {
  id: string;
  business_id: string;
  name: string;
  is_active: boolean;
}

interface LinkedContactRow {
  id: string;
  business_id: string;
  email: string | null;
}

interface ValidatedBookingParams {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceName: string;
  startTime: string;
  durationMinutes: number;
}

function requireBusinessTimeZone(
  timezone: string,
  errorMessage: string
): string {
  if (
    typeof timezone !== "string" ||
    timezone.trim().length === 0 ||
    timezone.length > MAX_TIMEZONE_LENGTH
  ) {
    throw new Error(errorMessage);
  }

  const normalizedTimezone = timezone.trim();

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimezone }).format(
      new Date(0)
    );
  } catch {
    throw new Error(errorMessage);
  }

  return normalizedTimezone;
}

function configuredInteger(
  environmentName: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[environmentName];
  if (raw === undefined || raw === "") return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${environmentName} calendar configuration.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${environmentName} calendar configuration.`);
  }
  return value;
}

function bookingWindowPolicy(): BookingWindowPolicy {
  return {
    minimumLeadMinutes: configuredInteger(
      "CALENDAR_BOOKING_MIN_LEAD_MINUTES",
      DEFAULT_BOOKING_MIN_LEAD_MINUTES,
      0,
      MAX_CONFIGURED_LEAD_MINUTES
    ),
    maximumHorizonDays: configuredInteger(
      "CALENDAR_BOOKING_MAX_HORIZON_DAYS",
      DEFAULT_BOOKING_MAX_HORIZON_DAYS,
      1,
      MAX_CONFIGURED_HORIZON_DAYS
    )
  };
}

function businessLocalParts(
  instant: Date,
  timezone: string
): BusinessLocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    date: `${String(values.year).padStart(4, "0")}-${String(values.month).padStart(2, "0")}-${String(values.day).padStart(2, "0")}`,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function cleanRequiredText(
  value: unknown,
  label: string,
  maximumLength: number
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required to create a booking.`);
  }
  if (value.length > maximumLength || UNSAFE_TEXT_PATTERN.test(value)) {
    throw new Error(
      `A valid ${label.toLowerCase()} is required to create a booking.`
    );
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > maximumLength ||
    UNSAFE_TEXT_PATTERN.test(normalized)
  ) {
    throw new Error(
      `A valid ${label.toLowerCase()} is required to create a booking.`
    );
  }
  return normalized;
}

function cleanOptionalText(
  value: unknown,
  label: string,
  maximumLength: number
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `A valid ${label.toLowerCase()} is required to create a booking.`
    );
  }
  if (value.length > maximumLength || UNSAFE_TEXT_PATTERN.test(value)) {
    throw new Error(
      `A valid ${label.toLowerCase()} is required to create a booking.`
    );
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > maximumLength ||
    UNSAFE_TEXT_PATTERN.test(normalized)
  ) {
    throw new Error(
      `A valid ${label.toLowerCase()} is required to create a booking.`
    );
  }
  return normalized;
}

function businessCalendarDate(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return new Date(Date.UTC(values.year, values.month - 1, values.day));
}

/**
 * Attempts to parse relative date strings into YYYY-MM-DD format.
 * Safety net in case the AI passes a non-ISO date string.
 */
function normalizeDate(input: string, timezone: string): string {
  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  const lower = input.toLowerCase().trim();
  const now = businessCalendarDate(new Date(), timezone);

  // Handle common relative dates
  if (lower === "today") {
    return formatYMD(now);
  }
  if (lower === "tomorrow") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    return formatYMD(d);
  }

  // Handle day names: "friday", "this friday", "next friday", etc.
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];
  const isNext = lower.startsWith("next ");
  const cleaned = lower.replace(/^(this |next )/, "");
  const dayIndex = dayNames.indexOf(cleaned);

  if (dayIndex !== -1) {
    const today = now.getUTCDay();
    let daysAhead = dayIndex - today;
    if (daysAhead <= 0) daysAhead += 7;
    if (isNext && daysAhead <= 7) daysAhead += 7;
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + daysAhead);
    return formatYMD(d);
  }

  // Return the original so strict downstream validation rejects unsupported
  // or ambiguous natural-language dates deterministically.
  return input;
}

function formatYMD(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isValidCalendarDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number(input.slice(0, 4)) < 1) {
    return false;
  }

  const parsed = new Date(`${input}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && formatYMD(parsed) === input;
}

function formatWallTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseBookingStartTime(input: string, timezone: string): Date {
  const localMatch = input.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/
  );
  if (localMatch) {
    return businessWallTimeToInstant(localMatch[1], localMatch[2], timezone);
  }

  const qualifiedMatch = input.match(
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:[0-5]\d)$/i
  );
  if (qualifiedMatch) {
    if (!isValidCalendarDate(qualifiedMatch[1])) {
      throw new Error(
        "Appointment start time contains an invalid calendar date."
      );
    }
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new Error(
    "Appointment start time must be YYYY-MM-DDTHH:mm:ss in the business timezone or an ISO 8601 timestamp with a UTC offset."
  );
}

function validateAvailabilityDate(
  normalizedDate: string,
  timezone: string,
  policy: BookingWindowPolicy,
  now: Date
): void {
  const today = formatYMD(businessCalendarDate(now, timezone));
  const horizonDate = formatYMD(
    businessCalendarDate(
      new Date(now.getTime() + policy.maximumHorizonDays * 24 * 60 * 60 * 1000),
      timezone
    )
  );
  if (normalizedDate < today) {
    throw new RangeError(
      "Appointment availability cannot be checked in the past."
    );
  }
  if (normalizedDate > horizonDate) {
    throw new RangeError("Appointment date is outside the booking horizon.");
  }
}

function validateBookingWindow(
  startDate: Date,
  endDate: Date,
  timezone: string,
  policy: BookingWindowPolicy,
  now: Date
): BusinessLocalParts {
  const localStart = businessLocalParts(startDate, timezone);
  const localEnd = businessLocalParts(endDate, timezone);
  if (
    startDate.getUTCMilliseconds() !== 0 ||
    localStart.second !== 0 ||
    localStart.minute % SLOT_DURATION_MINUTES !== 0
  ) {
    throw new RangeError(
      "Appointment start time must align to a 30-minute boundary."
    );
  }

  const earliestStart = new Date(
    now.getTime() + policy.minimumLeadMinutes * 60 * 1000
  );
  const latestStart = new Date(
    now.getTime() + policy.maximumHorizonDays * 24 * 60 * 60 * 1000
  );
  if (startDate < earliestStart) {
    throw new RangeError(
      `Appointment start time must be at least ${policy.minimumLeadMinutes} minutes in the future.`
    );
  }
  if (startDate > latestStart) {
    throw new RangeError(
      "Appointment start time is outside the booking horizon."
    );
  }
  if (localStart.date !== localEnd.date) {
    throw new RangeError(
      "Appointments must start and end on the same business day."
    );
  }
  return localStart;
}

function requireValidLinkage(linkage: BookingLinkage): void {
  for (const [label, value] of [
    ["Contact", linkage?.contactId],
    ["Conversation", linkage?.conversationId],
    ["Source message", linkage?.sourceMessageId]
  ] as const) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error(
        "Contact, conversation, and source message linkage are required."
      );
    }
    if (value.length > 36) {
      throw new Error(`${label} linkage is invalid.`);
    }
  }
}

function normalizeBookingParams(
  params: BookingParams,
  linkage: BookingLinkage
): ValidatedBookingParams {
  if (!params || typeof params !== "object") {
    throw new Error("Valid booking details are required.");
  }
  requireValidLinkage(linkage);

  const customerName = cleanRequiredText(
    params.customerName,
    "Customer name",
    MAX_CUSTOMER_NAME_LENGTH
  );
  const serviceName = cleanRequiredText(
    params.serviceName,
    "Service name",
    MAX_SERVICE_NAME_LENGTH
  );
  const customerPhone = cleanOptionalText(
    params.customerPhone,
    "Customer phone",
    MAX_CUSTOMER_PHONE_LENGTH
  );
  let customerEmail: string | undefined;
  if (params.customerEmail !== undefined && params.customerEmail !== null) {
    if (typeof params.customerEmail !== "string") {
      throw new Error(
        "A valid customer email is required to create a booking."
      );
    }
    customerEmail = normalizeEmail(params.customerEmail) ?? undefined;
    if (!customerEmail || customerEmail.length > MAX_CUSTOMER_EMAIL_LENGTH) {
      throw new Error(
        "A valid customer email is required to create a booking."
      );
    }
  }
  if (
    typeof params.startTime !== "string" ||
    params.startTime.length === 0 ||
    params.startTime.length > MAX_START_TIME_LENGTH ||
    UNSAFE_TEXT_PATTERN.test(params.startTime)
  ) {
    throw new Error("A valid booking start time is required.");
  }

  const durationMinutes = params.durationMinutes ?? SLOT_DURATION_MINUTES;
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < SLOT_DURATION_MINUTES ||
    durationMinutes > MAX_BOOKING_DURATION_MINUTES ||
    durationMinutes % SLOT_DURATION_MINUTES !== 0
  ) {
    throw new Error(
      "Booking duration must be between 30 and 240 minutes in 30-minute increments."
    );
  }

  return {
    customerName,
    customerPhone,
    customerEmail,
    serviceName,
    startTime: params.startTime,
    durationMinutes
  };
}

interface BookingParams {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceName: string;
  startTime: string; // Business-local wall time or offset-qualified ISO 8601
  durationMinutes?: number;
}

export interface BookingLinkage {
  contactId: string;
  conversationId: string;
  sourceMessageId: string;
}

interface BookingResult {
  eventId: string;
  summary: string;
  startTime: string;
  endTime: string;
}

export interface RecoverableCalendarBooking {
  id: string;
  business_id: string;
  contact_id: string;
  conversation_id: string;
  source_message_id: string;
  google_calendar_id: string;
  google_event_id: string | null;
  event_summary: string;
  request_fingerprint: string;
  operation_claim_token: string | null;
  operation_claimed_at: string | null;
  reconciliation_attempt_count: number;
  reconciliation_attempted_at: string | null;
  status: "pending" | "confirmed" | "failed" | "cancelled";
  starts_at: string;
  ends_at: string;
}

type CalendarBookingRow = RecoverableCalendarBooking;

export class DirectBookingNotEntitledError extends Error {
  constructor() {
    super("Direct booking is not available for this subscription.");
    this.name = "DirectBookingNotEntitledError";
  }
}

export class BookingSlotUnavailableError extends Error {
  constructor() {
    super("The requested appointment time is no longer available.");
    this.name = "BookingSlotUnavailableError";
  }
}

async function requireDirectBooking(businessId: string): Promise<void> {
  const entitlements = await resolveBusinessEntitlements(businessId);
  if (!canUseFeature(entitlements, "direct_booking")) {
    throw new DirectBookingNotEntitledError();
  }
}

async function loadExistingCalendarBooking(
  businessId: string,
  linkage: BookingLinkage
): Promise<CalendarBookingRow | null> {
  const { data, error } = await supabaseAdmin
    .from("calendar_bookings")
    .select(
      "id,business_id,contact_id,conversation_id,source_message_id,google_calendar_id,google_event_id,event_summary,request_fingerprint,operation_claim_token,operation_claimed_at,reconciliation_attempt_count,reconciliation_attempted_at,status,starts_at,ends_at"
    )
    .eq("business_id", businessId)
    .eq("source_message_id", linkage.sourceMessageId)
    .maybeSingle();
  if (error) {
    throw new Error("Could not check existing calendar booking state.");
  }
  if (!data) return null;

  const booking = requireCalendarBookingRow(data, "reserve");
  assertBookingLinkage(booking, businessId, linkage);
  return booking;
}

function requireCalendarId(value: unknown): string {
  const calendarId = typeof value === "string" ? value.trim() : "";
  if (
    !calendarId ||
    calendarId.length > 1024 ||
    UNSAFE_TEXT_PATTERN.test(calendarId)
  ) {
    throw new Error("The connected Google Calendar selection is invalid.");
  }
  return calendarId;
}

function requireCalendarProviderNamespace(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The connected Google Calendar identity is unavailable.");
  }
  const token = value as { calendar_id?: unknown; google_email?: unknown };
  const calendarId = requireCalendarId(token.calendar_id || "primary");
  const googleEmail =
    typeof token.google_email === "string"
      ? token.google_email.trim().toLowerCase()
      : "";
  if (!googleEmail || googleEmail.length > 320 || UNSAFE_TEXT_PATTERN.test(googleEmail)) {
    throw new Error("The connected Google Calendar identity is unavailable.");
  }
  return `${googleEmail}\n${calendarId}`;
}

function requireBusinessHours(
  data: unknown,
  businessId: string,
  dayOfWeek: number
): BusinessHours {
  const hours = data as Partial<BusinessHours> | null;
  if (
    !hours ||
    hours.business_id !== businessId ||
    hours.day_of_week !== dayOfWeek ||
    typeof hours.open_time !== "string" ||
    typeof hours.close_time !== "string" ||
    typeof hours.is_closed !== "boolean"
  ) {
    throw new Error("Configured business hours are unavailable.");
  }
  return hours as BusinessHours;
}

async function loadBookingCatalogContext(
  businessId: string,
  requestedServiceName: string,
  contactId: string,
  localStart: BusinessLocalParts,
  customerEmail?: string,
  confirmedVoiceEmail?: string
): Promise<{
  serviceId: string;
  serviceName: string;
  customerEmail?: string;
  hours: BusinessHours;
}> {
  const dayDate = new Date(`${localStart.date}T00:00:00.000Z`);
  const dayOfWeek = dayDate.getUTCDay();
  const [servicesResult, contactResult, hoursResult] = await Promise.all([
    supabaseAdmin
      .from("services")
      .select("id,business_id,name,is_active")
      .eq("business_id", businessId)
      .eq("is_active", true),
    supabaseAdmin
      .from("contacts")
      .select("id,business_id,email")
      .eq("business_id", businessId)
      .eq("id", contactId)
      .single(),
    supabaseAdmin
      .from("business_hours")
      .select("id,business_id,day_of_week,open_time,close_time,is_closed")
      .eq("business_id", businessId)
      .eq("day_of_week", dayOfWeek)
      .single()
  ]);

  if (servicesResult.error) {
    throw new Error("Could not validate the business service catalog.");
  }
  if (contactResult.error) {
    throw new Error("Could not validate the booking contact.");
  }
  if (hoursResult.error) {
    throw new Error("Could not validate configured business hours.");
  }

  const requestedServiceKey = normalizeKnowledgeKey(requestedServiceName);
  const matchingServices = Array.isArray(servicesResult.data)
    ? servicesResult.data.filter((candidate: unknown) => {
        const service = candidate as Partial<ActiveServiceRow>;
        return (
          typeof service.id === "string" &&
          UUID_PATTERN.test(service.id) &&
          service.business_id === businessId &&
          service.is_active === true &&
          typeof service.name === "string" &&
          service.name.length <= MAX_SERVICE_NAME_LENGTH &&
          !UNSAFE_TEXT_PATTERN.test(service.name) &&
          normalizeKnowledgeKey(service.name) === requestedServiceKey
        );
      })
    : [];
  if (matchingServices.length !== 1) {
    throw new Error(
      "The requested service must match one active service in the business catalog."
    );
  }
  const canonicalService = matchingServices[0] as ActiveServiceRow;

  const contact = contactResult.data as Partial<LinkedContactRow> | null;
  if (
    !contact ||
    contact.id !== contactId ||
    contact.business_id !== businessId ||
    !(contact.email === null || typeof contact.email === "string")
  ) {
    throw new Error("The booking contact could not be validated.");
  }
  if (customerEmail) {
    const persistedEmail = normalizeEmail(contact.email);
    if (persistedEmail !== customerEmail && confirmedVoiceEmail !== customerEmail) {
      throw new Error(
        "A calendar invitation can only be sent to the validated email saved on this contact."
      );
    }
  }

  return {
    serviceId: canonicalService.id,
    serviceName: canonicalService.name
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " "),
    customerEmail,
    hours: requireBusinessHours(hoursResult.data, businessId, dayOfWeek)
  };
}

function assertWithinBusinessHours(
  startDate: Date,
  endDate: Date,
  localStart: BusinessLocalParts,
  timezone: string,
  hours: BusinessHours
): void {
  if (hours.is_closed) {
    throw new RangeError(
      "The business is closed at the requested appointment time."
    );
  }
  const opensAt = businessWallTimeToInstant(
    localStart.date,
    hours.open_time,
    timezone
  );
  const closesAt = businessWallTimeToInstant(
    localStart.date,
    hours.close_time,
    timezone
  );
  if (closesAt <= opensAt || startDate < opensAt || endDate > closesAt) {
    throw new RangeError(
      "The requested appointment must fit entirely within configured business hours."
    );
  }
}

function validatedBusyPeriods(
  response: { data: calendar_v3.Schema$FreeBusyResponse },
  calendarId: string
): Array<{ start: number; end: number }> {
  const calendarResult = response?.data?.calendars?.[calendarId];
  const errors = calendarResult?.errors;
  if (
    !calendarResult ||
    (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) ||
    (calendarResult.busy !== undefined && !Array.isArray(calendarResult.busy))
  ) {
    throw new Error("Google Calendar availability could not be verified.");
  }

  return (calendarResult.busy ?? []).map((period) => {
    const start =
      typeof period.start === "string" ? Date.parse(period.start) : Number.NaN;
    const end =
      typeof period.end === "string" ? Date.parse(period.end) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error("Google Calendar returned invalid availability data.");
    }
    return { start, end };
  });
}

async function calendarRangeIsBusy(
  calendar: ReturnType<typeof getCalendarService>,
  calendarId: string,
  startDate: Date,
  endDate: Date,
  timezone: string
): Promise<boolean> {
  const response = await calendar.freebusy.query(
    {
      requestBody: {
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        timeZone: timezone,
        items: [{ id: calendarId }]
      }
    },
    { timeout: CALENDAR_AVAILABILITY_TIMEOUT_MS, retry: false }
  );
  return validatedBusyPeriods(response, calendarId).some(
    (period) =>
      startDate.getTime() < period.end && endDate.getTime() > period.start
  );
}

export async function checkAvailability(
  businessId: string,
  date: string, // YYYY-MM-DD
  timezone: string,
  voiceAuthority?: VoiceBookingAuthority
): Promise<string[]> {
  const businessTimezone = requireBusinessTimeZone(
    timezone,
    "A valid IANA business timezone is required to check availability."
  );
  await assertBookingOperationallyAllowed(businessId);
  if (voiceAuthority) await validateVoiceBookingAccess(businessId, voiceAuthority);
  else await requireDirectBooking(businessId);
  if (
    typeof date !== "string" ||
    date.length === 0 ||
    date.length > 32 ||
    UNSAFE_TEXT_PATTERN.test(date)
  ) {
    throw new RangeError("A valid appointment date is required.");
  }
  const policy = bookingWindowPolicy();
  const now = new Date();
  const normalizedDate = normalizeDate(date, businessTimezone);
  if (!isValidCalendarDate(normalizedDate)) {
    throw new RangeError(`Invalid appointment date: ${date}`);
  }
  validateAvailabilityDate(normalizedDate, businessTimezone, policy, now);

  const client = await getAuthenticatedClient(businessId);
  if (!client) {
    throw new Error("Google Calendar not connected");
  }

  const calendar = getCalendarService(client);

  // Get the calendar ID for this business
  const { data: tokenData, error: tokenError } = await supabaseAdmin
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", businessId)
    .single();
  if (tokenError) {
    throw new Error("Could not load the connected Google Calendar.");
  }
  const calendarId = requireCalendarId(tokenData?.calendar_id || "primary");

  // Get business hours for this day
  const dayDate = new Date(`${normalizedDate}T00:00:00.000Z`);
  const dayOfWeek = dayDate.getUTCDay();

  const { data: hoursData, error: hoursError } = await supabaseAdmin
    .from("business_hours")
    .select("*")
    .eq("business_id", businessId)
    .eq("day_of_week", dayOfWeek)
    .single();
  if (hoursError) {
    throw new Error("Could not load configured business hours.");
  }
  const hours = requireBusinessHours(hoursData, businessId, dayOfWeek);
  if (hours.is_closed) {
    await assertBookingOperationallyAllowed(businessId);
    return [];
  }

  // Query Google Calendar for busy times using absolute instants derived from
  // the business-local date and hours.
  const minDate = businessWallTimeToInstant(
    normalizedDate,
    hours.open_time,
    businessTimezone
  );
  const maxDate = businessWallTimeToInstant(
    normalizedDate,
    hours.close_time,
    businessTimezone
  );
  if (maxDate <= minDate) {
    throw new Error("Configured business hours contain an invalid time range.");
  }

  await assertBookingOperationallyAllowed(businessId);
  const freeBusy = await calendar.freebusy.query(
    {
      requestBody: {
        timeMin: minDate.toISOString(),
        timeMax: maxDate.toISOString(),
        timeZone: businessTimezone,
        items: [{ id: calendarId }]
      }
    },
    { timeout: CALENDAR_AVAILABILITY_TIMEOUT_MS, retry: false }
  );
  await assertBookingOperationallyAllowed(businessId);

  const busySlots = validatedBusyPeriods(freeBusy, calendarId);
  const earliestStart = new Date(
    now.getTime() + policy.minimumLeadMinutes * 60 * 1000
  );
  const latestStart = new Date(
    now.getTime() + policy.maximumHorizonDays * 24 * 60 * 60 * 1000
  );

  // Generate all possible slots during business hours
  const slots: string[] = [];
  const [openHour, openMin] = hours.open_time.split(":").map(Number);
  const [closeHour, closeMin] = hours.close_time.split(":").map(Number);

  const openMinutes = openHour * 60 + openMin;
  const closeMinutes = closeHour * 60 + closeMin;

  const firstAlignedSlot =
    Math.ceil(openMinutes / SLOT_DURATION_MINUTES) * SLOT_DURATION_MINUTES;
  for (
    let m = firstAlignedSlot;
    m + SLOT_DURATION_MINUTES <= closeMinutes;
    m += SLOT_DURATION_MINUTES
  ) {
    let slotStart: Date;
    try {
      slotStart = businessWallTimeToInstant(
        normalizedDate,
        formatWallTime(m),
        businessTimezone
      );
    } catch (error) {
      // A wall-clock slot in the spring-forward gap does not exist and must
      // never be advertised as available.
      if (error instanceof RangeError) continue;
      throw error;
    }

    const slotEnd = new Date(
      slotStart.getTime() + SLOT_DURATION_MINUTES * 60 * 1000
    );

    if (slotStart < earliestStart || slotStart > latestStart) continue;

    // Check if this slot overlaps with any busy period
    const isBusy = busySlots.some((busy) => {
      return slotStart.getTime() < busy.end && slotEnd.getTime() > busy.start;
    });

    if (!isBusy) {
      // Format as readable time
      const hour = Math.floor(m / 60);
      const min = m % 60;
      const period = hour >= 12 ? "PM" : "AM";
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const displayMin = min === 0 ? "00" : String(min).padStart(2, "0");
      slots.push(`${displayHour}:${displayMin} ${period}`);
    }
  }

  return slots;
}

export async function createBooking(
  businessId: string,
  params: BookingParams,
  timezone: string,
  linkage: BookingLinkage,
  voiceAuthority?: VoiceBookingAuthority
): Promise<BookingResult> {
  const businessTimezone = requireBusinessTimeZone(
    timezone,
    CREATE_BOOKING_TIMEZONE_ERROR
  );
  await assertBookingOperationallyAllowed(businessId);
  const voiceConfirmation = voiceAuthority
    ? await validateVoiceBookingAccess(businessId, voiceAuthority, linkage.sourceMessageId, params)
    : null;
  if (!voiceAuthority) await requireDirectBooking(businessId);
  const normalizedParams = normalizeBookingParams(params, linkage);
  const startDate = parseBookingStartTime(
    normalizedParams.startTime,
    businessTimezone
  );
  const endDate = new Date(
    startDate.getTime() + normalizedParams.durationMinutes * 60 * 1000
  );
  const existingBooking = await loadExistingCalendarBooking(
    businessId,
    linkage
  );
  if (existingBooking?.status === "confirmed") {
    return bookingResultFromRow(existingBooking);
  }
  if (existingBooking?.status === "cancelled") {
    throw new Error(
      `Calendar booking ${existingBooking.id} cannot be created from status cancelled.`
    );
  }
  if (existingBooking?.status === "pending") {
    const recoveryClient = await getAuthenticatedClient(businessId);
    if (!recoveryClient) {
      throw new Error("Google Calendar not connected");
    }
    const recoveredEvent = await findReservedGoogleEvent(
      getCalendarService(recoveryClient),
      existingBooking.google_calendar_id,
      existingBooking.id
    );
    if (recoveredEvent) {
      const confirmed = await confirmCalendarBooking(
        businessId,
        existingBooking.id,
        requireGoogleEventId(recoveredEvent.id, existingBooking.id),
        eventDateTime(
          recoveredEvent.start?.dateTime,
          new Date(existingBooking.starts_at)
        ),
        eventDateTime(
          recoveredEvent.end?.dateTime,
          new Date(existingBooking.ends_at)
        ),
        requireBookingClaimToken(existingBooking)
      );
      assertBookingLinkage(confirmed, businessId, linkage, existingBooking);
      return bookingResultFromRow(confirmed);
    }
  }

  const localStart = validateBookingWindow(
    startDate,
    endDate,
    businessTimezone,
    bookingWindowPolicy(),
    new Date()
  );
  const bookingContext = await loadBookingCatalogContext(
    businessId,
    normalizedParams.serviceName,
    linkage.contactId,
    localStart,
    normalizedParams.customerEmail,
    voiceConfirmation?.email
  );
  assertWithinBusinessHours(
    startDate,
    endDate,
    localStart,
    businessTimezone,
    bookingContext.hours
  );
  const canonicalParams: ValidatedBookingParams = {
    ...normalizedParams,
    serviceName: bookingContext.serviceName,
    customerEmail: bookingContext.customerEmail
  };

  const { data: tokenData, error: tokenError } = await supabaseAdmin
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", businessId)
    .single();

  if (tokenError) {
    throw new Error("Could not load the connected Google Calendar.");
  }

  const preflightNamespace = requireCalendarProviderNamespace(tokenData);
  const selectedCalendarId = requireCalendarId(
    tokenData?.calendar_id || "primary"
  );
  const preflightClient = await getAuthenticatedClient(businessId);
  if (!preflightClient) {
    throw new Error("Google Calendar not connected");
  }
  const requestedSummary = `${canonicalParams.serviceName} - ${canonicalParams.customerName}`;
  const requestFingerprint = bookingRequestFingerprint(
    params,
    businessTimezone,
    startDate,
    endDate
  );

  const claimToken = randomUUID();
  const reservation = await reserveCalendarBooking(
    businessId,
    linkage,
    startDate,
    endDate,
    claimToken,
    selectedCalendarId,
    requestedSummary,
    requestFingerprint
  );
  assertBookingLinkage(reservation, businessId, linkage);
  const calendarId = reservation.google_calendar_id;
  const summary = reservation.event_summary;

  // Entry authorization applies to the invocation, but once that allowed
  // invocation has reserved work, durable/provider evidence must converge even
  // if a pause lands. A confirmed reservation is the idempotency result.
  if (reservation.status === "confirmed") {
    return bookingResultFromRow(reservation);
  }
  if (reservation.status !== "pending") {
    throw new Error(
      `Calendar booking ${reservation.id} cannot be created from status ${reservation.status}.`
    );
  }
  if (reservation.request_fingerprint !== requestFingerprint) {
    throw new Error(
      `Calendar booking ${reservation.id} was replayed with different booking details.`
    );
  }

  const { data: currentToken, error: currentTokenError } = await supabaseAdmin
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", businessId)
    .single();
  let currentNamespace: string | null = null;
  try {
    if (currentToken) {
      currentNamespace = requireCalendarProviderNamespace(currentToken);
    }
  } catch {
    // Treat malformed post-reservation identity as a namespace change, then
    // release the provably pre-submission reservation below.
  }
  if (
    currentTokenError ||
    currentNamespace !== preflightNamespace
  ) {
    const stopped = await stopCalendarBookingBeforeProviderSubmission(
      reservation,
      claimToken
    );
    if (stopped.status === "confirmed") return bookingResultFromRow(stopped);
    throw new Error("Google Calendar connection changed. Please retry.");
  }

  // Load/reload credentials only after the durable reservation owns the
  // business mutex boundary. OAuth completion may switch provider namespaces
  // before this point, but once pending work exists it can only refresh the
  // same proven Google account/calendar namespace.
  let client: Awaited<ReturnType<typeof getAuthenticatedClient>>;
  try {
    client = await getAuthenticatedClient(businessId);
  } catch {
    const stopped = await stopCalendarBookingBeforeProviderSubmission(
      reservation,
      claimToken
    );
    if (stopped.status === "confirmed") {
      assertBookingLinkage(stopped, businessId, linkage, reservation);
      return bookingResultFromRow(stopped);
    }
    throw new Error("Google Calendar credentials are temporarily unavailable.");
  }
  if (!client) {
    const stopped = await stopCalendarBookingBeforeProviderSubmission(
      reservation,
      claimToken
    );
    if (stopped.status === "confirmed") {
      assertBookingLinkage(stopped, businessId, linkage, reservation);
      return bookingResultFromRow(stopped);
    }
    throw new Error("Google Calendar not connected");
  }
  const calendar = getCalendarService(client);
  const reservedStartDate = new Date(reservation.starts_at);
  const reservedEndDate = new Date(reservation.ends_at);
  const recoveredEvent = await findReservedGoogleEvent(
    calendar,
    calendarId,
    reservation.id
  );
  if (recoveredEvent) {
    // Recovery is confirmation work, not a new provider mutation, so it stays
    // ungated after this invocation crossed its entry/reservation boundary.
    const recoveredEventId = requireGoogleEventId(
      recoveredEvent.id,
      reservation.id
    );
    const confirmed = await confirmCalendarBooking(
      businessId,
      reservation.id,
      recoveredEventId,
      eventDateTime(recoveredEvent.start?.dateTime, reservedStartDate),
      eventDateTime(recoveredEvent.end?.dateTime, reservedEndDate),
      requireBookingClaimToken(reservation)
    );
    assertBookingLinkage(confirmed, businessId, linkage, reservation);
    return bookingResultFromRow(confirmed);
  }
  if (reservation.operation_claim_token !== claimToken) {
    throw new CalendarBookingInProgressError(reservation.id);
  }

  const descriptionParts = [`Service: ${canonicalParams.serviceName}`];
  if (canonicalParams.customerPhone)
    descriptionParts.push(`Phone: ${canonicalParams.customerPhone}`);
  if (canonicalParams.customerEmail)
    descriptionParts.push(`Email: ${canonicalParams.customerEmail}`);
  descriptionParts.push("Booked via AI assistant");

  const requestBody: Record<string, unknown> = {
    id: googleEventIdForBooking(reservation.id),
    summary,
    description: descriptionParts.join("\n"),
    start: {
      dateTime: reservedStartDate.toISOString(),
      timeZone: businessTimezone
    },
    end: {
      dateTime: reservedEndDate.toISOString(),
      timeZone: businessTimezone
    },
    reminders: {
      useDefault: true
    },
    extendedProperties: {
      private: {
        simplassist_booking_id: reservation.id,
        simplassist_business_id: businessId,
        simplassist_contact_id: linkage.contactId,
        simplassist_conversation_id: linkage.conversationId,
        simplassist_source_message_id: linkage.sourceMessageId,
        simplassist_service_id: bookingContext.serviceId
      }
    }
  };

  // Add customer as attendee so Google sends them a calendar invite
  if (canonicalParams.customerEmail) {
    requestBody.attendees = [{ email: canonicalParams.customerEmail }];
  }

  const rangeIsBusy = await calendarRangeIsBusy(
    calendar,
    calendarId,
    reservedStartDate,
    reservedEndDate,
    businessTimezone
  );
  if (rangeIsBusy) {
    const stopped = await stopCalendarBookingForUnavailableSlot(
      reservation,
      claimToken
    );
    if (stopped.status === "confirmed") {
      assertBookingLinkage(stopped, businessId, linkage, reservation);
      return bookingResultFromRow(stopped);
    }
    throw new BookingSlotUnavailableError();
  }

  try {
    await assertBookingOperationallyAllowed(businessId);
  } catch (error) {
    if (!isBookingOperationalBlockedError(error)) throw error;

    const stopped = await stopCalendarBookingBeforeProviderSubmission(
      reservation,
      claimToken
    );
    if (stopped.status === "confirmed") {
      assertBookingLinkage(stopped, businessId, linkage, reservation);
      return bookingResultFromRow(stopped);
    }
    throw error;
  }

  const submissionReservation =
    await markCalendarBookingSubmissionStarted(reservation, claimToken);
  if (submissionReservation.status === "confirmed") {
    assertBookingLinkage(
      submissionReservation,
      businessId,
      linkage,
      reservation
    );
    return bookingResultFromRow(submissionReservation);
  }

  let event;
  if (voiceAuthority) {
    try {
      // Availability and credential checks can take time. Re-read the exact
      // caller confirmation at the last boundary before any Google mutation.
      await validateVoiceBookingAccess(businessId, voiceAuthority, linkage.sourceMessageId, params);
    } catch {
      // This invocation has not called Google. Its own claim can be released;
      // a failure to prove cleanup remains an uncertain result for recovery.
      const stopped = await stopCalendarBookingBeforeProviderSubmission(
        submissionReservation,
        claimToken,
      );
      if (stopped.status === "confirmed") {
        assertBookingLinkage(stopped, businessId, linkage, reservation);
        return bookingResultFromRow(stopped);
      }
      throw new VoiceBookingNotSubmittedError();
    }
  }
  try {
    event = await calendar.events.insert(
      {
        calendarId,
        sendUpdates: "all",
        requestBody
      },
      { timeout: CALENDAR_MUTATION_TIMEOUT_MS, retry: false }
    );
  } catch (error) {
    const recoveredAfterError = await recoverAfterGoogleInsertError(
      calendar,
      reservation
    );
    if (recoveredAfterError) {
      const confirmed = await confirmRecoveredCalendarBooking(
        reservation,
        recoveredAfterError
      );
      assertBookingLinkage(confirmed, businessId, linkage, reservation);
      return bookingResultFromRow(confirmed);
    }
    if (isDefinitiveGoogleInsertFailure(error)) {
      await markCalendarBookingFailedBestEffort(
        businessId,
        reservation.id,
        claimToken
      );
    }
    throw error;
  }

  // From this point on Google may have created the event. Never mark the local
  // reservation failed: a retry can find it by the private booking ID and
  // finish the local confirmation without creating a duplicate event.
  const eventId = requireGoogleEventId(event.data.id, reservation.id);
  const confirmed = await confirmCalendarBooking(
    businessId,
    reservation.id,
    eventId,
    eventDateTime(event.data.start?.dateTime, reservedStartDate),
    eventDateTime(event.data.end?.dateTime, reservedEndDate),
    claimToken
  );

  assertBookingLinkage(confirmed, businessId, linkage, reservation);
  return bookingResultFromRow(confirmed);
}

function bookingRequestFingerprint(
  params: BookingParams,
  timezone: string,
  startDate: Date,
  endDate: Date
): string {
  const canonicalPayload = {
    customerName: params.customerName.normalize("NFKC").trim(),
    customerPhone: params.customerPhone?.normalize("NFKC").trim() || null,
    customerEmail:
      params.customerEmail?.normalize("NFKC").trim().toLowerCase() || null,
    serviceName: params.serviceName.normalize("NFKC").trim(),
    startTime: startDate.toISOString(),
    endTime: endDate.toISOString(),
    timezone: timezone.trim()
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalPayload))
    .digest("hex");
}

async function reserveCalendarBooking(
  businessId: string,
  linkage: BookingLinkage,
  startDate: Date,
  endDate: Date,
  claimToken: string,
  googleCalendarId: string,
  eventSummary: string,
  requestFingerprint: string
): Promise<CalendarBookingRow> {
  const { data, error } = await supabaseAdmin.rpc("reserve_calendar_booking", {
    p_business_id: businessId,
    p_contact_id: linkage.contactId,
    p_conversation_id: linkage.conversationId,
    p_source_message_id: linkage.sourceMessageId,
    p_starts_at: startDate.toISOString(),
    p_ends_at: endDate.toISOString(),
    p_claim_token: claimToken,
    p_google_calendar_id: googleCalendarId,
    p_event_summary: eventSummary,
    p_request_fingerprint: requestFingerprint
  });
  if (error) {
    await assertBookingOperationallyAllowed(businessId);
    if (
      error.code === "23P01" ||
      error.message === "calendar_booking_slot_unavailable" ||
      error.message?.includes("calendar_booking_slot_unavailable")
    ) {
      throw new BookingSlotUnavailableError();
    }
    throw new Error(`Could not reserve calendar booking: ${error.message}`);
  }
  return requireCalendarBookingRow(data, "reserve");
}

async function stopCalendarBookingBeforeProviderSubmission(
  reservation: CalendarBookingRow,
  claimToken: string
): Promise<CalendarBookingRow> {
  return stopClaimedCalendarBooking(
    reservation,
    claimToken,
    "Booking was blocked before Google Calendar submission."
  );
}

async function markCalendarBookingSubmissionStarted(
  reservation: CalendarBookingRow,
  claimToken: string
): Promise<CalendarBookingRow> {
  if (!reservation.operation_claimed_at) {
    throw new CalendarBookingInProgressError(reservation.id);
  }
  const { data, error } = await supabaseAdmin.rpc(
    "mark_calendar_booking_submission_started",
    {
      p_business_id: reservation.business_id,
      p_booking_id: reservation.id,
      p_claim_token: claimToken,
      p_expected_claimed_at: reservation.operation_claimed_at
    }
  );
  if (error) {
    if (error.code === "42501") {
      throw new CalendarBookingInProgressError(reservation.id);
    }
    await assertBookingOperationallyAllowed(reservation.business_id);
    throw new Error("Could not fence calendar booking submission.");
  }
  const fenced = requireCalendarBookingRow(data, "mark_submission_started");
  if (
    fenced.id !== reservation.id ||
    fenced.business_id !== reservation.business_id ||
    (fenced.status === "pending" &&
      (fenced.operation_claim_token !== claimToken ||
        !fenced.operation_claimed_at))
  ) {
    throw new Error("Calendar booking submission fence was invalid.");
  }
  return fenced;
}

async function stopCalendarBookingForUnavailableSlot(
  reservation: CalendarBookingRow,
  claimToken: string
): Promise<CalendarBookingRow> {
  return stopClaimedCalendarBooking(
    reservation,
    claimToken,
    "The requested appointment time was no longer available."
  );
}

async function stopClaimedCalendarBooking(
  reservation: CalendarBookingRow,
  claimToken: string,
  failureReason: string
): Promise<CalendarBookingRow> {
  let result: { data: unknown; error: { message?: unknown } | null };
  try {
    result = await supabaseAdmin.rpc("fail_calendar_booking", {
      p_business_id: reservation.business_id,
      p_booking_id: reservation.id,
      p_claim_token: claimToken,
      p_failure_reason: failureReason
    });
  } catch (error) {
    throw bookingCleanupError(reservation, error);
  }

  if (result.error) {
    throw bookingCleanupError(reservation, result.error);
  }

  let stopped: CalendarBookingRow;
  try {
    stopped = requireCalendarBookingRow(result.data, "fail");
    assertBookingLinkage(
      stopped,
      reservation.business_id,
      {
        contactId: reservation.contact_id,
        conversationId: reservation.conversation_id,
        sourceMessageId: reservation.source_message_id
      },
      reservation
    );
  } catch (error) {
    throw bookingCleanupError(reservation, error);
  }

  const failedCleanly =
    stopped.status === "failed" &&
    stopped.google_event_id === null &&
    stopped.operation_claim_token === null &&
    stopped.operation_claimed_at === null;
  const concurrentlyConfirmed =
    stopped.status === "confirmed" &&
    Boolean(stopped.google_event_id) &&
    stopped.operation_claim_token === null &&
    stopped.operation_claimed_at === null;
  if (!failedCleanly && !concurrentlyConfirmed) {
    throw bookingCleanupError(reservation);
  }
  return stopped;
}

function bookingCleanupError(
  reservation: CalendarBookingRow,
  cause?: unknown
): BookingOperationalStateError {
  return new BookingOperationalStateError({
    businessId: reservation.business_id,
    code: "booking_cleanup_failed",
    message: `Could not safely stop calendar booking ${reservation.id} before provider submission.`,
    cause
  });
}

async function confirmCalendarBooking(
  businessId: string,
  bookingId: string,
  googleEventId: string,
  startsAt: string,
  endsAt: string,
  claimToken: string
): Promise<CalendarBookingRow> {
  const { data, error } = await supabaseAdmin.rpc("confirm_calendar_booking", {
    p_business_id: businessId,
    p_booking_id: bookingId,
    p_google_event_id: googleEventId,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
    p_claim_token: claimToken
  });
  if (error) {
    throw new Error(`Could not confirm calendar booking: ${error.message}`);
  }
  return requireCalendarBookingRow(data, "confirm");
}

function requireCalendarBookingRow(
  data: unknown,
  operation: "reserve" | "confirm" | "fail" | "mark_submission_started"
): CalendarBookingRow {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as CalendarBookingRow).id !== "string" ||
    typeof (candidate as CalendarBookingRow).business_id !== "string" ||
    typeof (candidate as CalendarBookingRow).contact_id !== "string" ||
    typeof (candidate as CalendarBookingRow).conversation_id !== "string" ||
    typeof (candidate as CalendarBookingRow).source_message_id !== "string" ||
    typeof (candidate as CalendarBookingRow).google_calendar_id !== "string" ||
    !(candidate as CalendarBookingRow).google_calendar_id.trim() ||
    typeof (candidate as CalendarBookingRow).event_summary !== "string" ||
    !(candidate as CalendarBookingRow).event_summary.trim() ||
    typeof (candidate as CalendarBookingRow).request_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(
      (candidate as CalendarBookingRow).request_fingerprint
    ) ||
    !["pending", "confirmed", "failed", "cancelled"].includes(
      (candidate as CalendarBookingRow).status
    ) ||
    !(
      (candidate as CalendarBookingRow).google_event_id === null ||
      typeof (candidate as CalendarBookingRow).google_event_id === "string"
    ) ||
    !(
      (candidate as CalendarBookingRow).operation_claim_token === null ||
      typeof (candidate as CalendarBookingRow).operation_claim_token ===
        "string"
    ) ||
    !(
      (candidate as CalendarBookingRow).operation_claimed_at === null ||
      typeof (candidate as CalendarBookingRow).operation_claimed_at === "string"
    ) ||
    !Number.isSafeInteger(
      (candidate as CalendarBookingRow).reconciliation_attempt_count
    ) ||
    (candidate as CalendarBookingRow).reconciliation_attempt_count < 0 ||
    !(
      (candidate as CalendarBookingRow).reconciliation_attempted_at === null ||
      typeof (candidate as CalendarBookingRow).reconciliation_attempted_at ===
        "string"
    ) ||
    typeof (candidate as CalendarBookingRow).starts_at !== "string" ||
    typeof (candidate as CalendarBookingRow).ends_at !== "string"
  ) {
    throw new Error(
      `Calendar booking ${operation} returned an invalid booking row.`
    );
  }
  return candidate as CalendarBookingRow;
}

function assertBookingLinkage(
  booking: CalendarBookingRow,
  businessId: string,
  linkage: BookingLinkage,
  expectedReservation?: CalendarBookingRow
): void {
  if (
    booking.business_id !== businessId ||
    booking.contact_id !== linkage.contactId ||
    booking.conversation_id !== linkage.conversationId ||
    booking.source_message_id !== linkage.sourceMessageId ||
    (expectedReservation !== undefined &&
      (booking.id !== expectedReservation.id ||
        booking.google_calendar_id !== expectedReservation.google_calendar_id ||
        booking.event_summary !== expectedReservation.event_summary ||
        booking.request_fingerprint !==
          expectedReservation.request_fingerprint))
  ) {
    throw new Error(
      `Calendar booking ${booking.id} returned inconsistent tenant or linkage data.`
    );
  }
}

export class CalendarBookingInProgressError extends Error {
  constructor(readonly bookingId: string) {
    super(`Calendar booking ${bookingId} is already being created.`);
    this.name = "CalendarBookingInProgressError";
  }
}

function requireBookingClaimToken(booking: CalendarBookingRow): string {
  if (!booking.operation_claim_token) {
    throw new Error(
      `Calendar booking ${booking.id} has no active operation claim.`
    );
  }
  return booking.operation_claim_token;
}

async function findReservedGoogleEvent(
  calendar: ReturnType<typeof getCalendarService>,
  calendarId: string,
  bookingId: string
): Promise<calendar_v3.Schema$Event | null> {
  const deterministicEventId = googleEventIdForBooking(bookingId);
  try {
    const direct = await calendar.events.get(
      {
        calendarId,
        eventId: deterministicEventId
      },
      { timeout: CALENDAR_RECOVERY_TIMEOUT_MS, retry: false }
    );
    if (direct.data.id !== deterministicEventId) {
      throw new Error("Google Calendar returned an invalid booking event.");
    }
    assertGoogleEventBookingId(direct.data, bookingId);
    if (direct.data.status !== "cancelled") return direct.data;
  } catch (error) {
    if (!isGoogleEventNotFound(error)) throw error;
  }

  const response = await calendar.events.list(
    {
      calendarId,
      maxResults: 1,
      showDeleted: false,
      singleEvents: true,
      privateExtendedProperty: [`simplassist_booking_id=${bookingId}`]
    },
    { timeout: CALENDAR_RECOVERY_TIMEOUT_MS, retry: false }
  );
  const found =
    response.data.items?.find(
      (event) => Boolean(event.id) && event.status !== "cancelled"
    ) ?? null;
  if (found) assertGoogleEventBookingId(found, bookingId);
  return found;
}

function googleEventIdForBooking(bookingId: string): string {
  const eventId = bookingId.replace(/-/g, "").toLowerCase();
  if (
    eventId.length < 5 ||
    eventId.length > 1024 ||
    !/^[0-9a-v]+$/.test(eventId)
  ) {
    throw new Error(
      `Calendar booking ${bookingId} cannot form a valid Google event ID.`
    );
  }
  return eventId;
}

function assertGoogleEventBookingId(
  event: calendar_v3.Schema$Event,
  bookingId: string
): void {
  if (event.extendedProperties?.private?.simplassist_booking_id !== bookingId) {
    throw new Error(
      `Google event ${event.id ?? "(missing id)"} does not belong to booking ${bookingId}.`
    );
  }
}

function isGoogleEventNotFound(error: unknown): boolean {
  const status = googleErrorStatus(error);
  return status === 404 || status === 410;
}

function googleErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    candidate.code,
    candidate.status,
    candidate.response?.status
  ]) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function isDefinitiveGoogleInsertFailure(error: unknown): boolean {
  const status = googleErrorStatus(error);
  return (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429, 499].includes(status)
  );
}

async function recoverAfterGoogleInsertError(
  calendar: ReturnType<typeof getCalendarService>,
  booking: CalendarBookingRow
): Promise<calendar_v3.Schema$Event | null> {
  try {
    return await findReservedGoogleEvent(
      calendar,
      booking.google_calendar_id,
      booking.id
    );
  } catch {
    console.error(
      `[calendar] Could not reconcile ambiguous Google insert for booking ${booking.id}`
    );
    return null;
  }
}

async function confirmRecoveredCalendarBooking(
  booking: CalendarBookingRow,
  event: calendar_v3.Schema$Event
): Promise<CalendarBookingRow> {
  return confirmCalendarBooking(
    booking.business_id,
    booking.id,
    requireGoogleEventId(event.id, booking.id),
    eventDateTime(event.start?.dateTime, new Date(booking.starts_at)),
    eventDateTime(event.end?.dateTime, new Date(booking.ends_at)),
    requireBookingClaimToken(booking)
  );
}

export async function recoverCalendarBookingConfirmation(
  booking: RecoverableCalendarBooking
): Promise<boolean> {
  const parsed = requireCalendarBookingRow(booking, "reserve");
  if (parsed.status === "confirmed") return true;
  if (parsed.status !== "pending") {
    throw new Error(
      `Calendar booking ${parsed.id} is not pending confirmation.`
    );
  }
  requireBookingClaimToken(parsed);

  const client = await withCalendarDeadline(
    getAuthenticatedClient(parsed.business_id),
    CALENDAR_CREDENTIAL_TIMEOUT_MS
  );
  if (!client) {
    throw new Error(
      `Google Calendar is not connected for booking ${parsed.id}.`
    );
  }
  const event = await findReservedGoogleEvent(
    getCalendarService(client),
    parsed.google_calendar_id,
    parsed.id
  );
  if (!event) return false;

  const confirmed = await confirmRecoveredCalendarBooking(parsed, event);
  assertBookingLinkage(
    confirmed,
    parsed.business_id,
    {
      contactId: parsed.contact_id,
      conversationId: parsed.conversation_id,
      sourceMessageId: parsed.source_message_id
    },
    parsed
  );
  return true;
}

export async function claimCalendarBookingReconciliation(
  booking: RecoverableCalendarBooking
): Promise<RecoverableCalendarBooking> {
  const parsed = requireCalendarBookingRow(booking, "reserve");
  const { data, error } = await supabaseAdmin.rpc(
    "claim_calendar_booking_reconciliation",
    {
      p_business_id: parsed.business_id,
      p_booking_id: parsed.id,
      p_claim_token: requireBookingClaimToken(parsed)
    }
  );
  if (error) {
    throw new Error(
      `Could not claim calendar booking ${parsed.id} for reconciliation: ${error.message}`
    );
  }

  const claimed = requireCalendarBookingRow(data, "reserve");
  assertBookingLinkage(
    claimed,
    parsed.business_id,
    {
      contactId: parsed.contact_id,
      conversationId: parsed.conversation_id,
      sourceMessageId: parsed.source_message_id
    },
    parsed
  );
  return claimed;
}

export async function failCalendarBookingRecovery(
  booking: RecoverableCalendarBooking
): Promise<RecoverableCalendarBooking["status"]> {
  const parsed = requireCalendarBookingRow(booking, "reserve");
  if (parsed.status !== "pending") return parsed.status;

  const { data, error } = await supabaseAdmin.rpc("fail_calendar_booking", {
    p_business_id: parsed.business_id,
    p_booking_id: parsed.id,
    p_claim_token: requireBookingClaimToken(parsed),
    p_failure_reason:
      "Google Calendar event was not found during booking reconciliation."
  });
  if (error) {
    throw new Error(
      `Could not release missing calendar booking ${parsed.id}: ${error.message}`
    );
  }

  const released = requireCalendarBookingRow(data, "fail");
  assertBookingLinkage(
    released,
    parsed.business_id,
    {
      contactId: parsed.contact_id,
      conversationId: parsed.conversation_id,
      sourceMessageId: parsed.source_message_id
    },
    parsed
  );
  return released.status;
}

function requireGoogleEventId(
  eventId: string | null | undefined,
  bookingId: string
): string {
  if (!eventId) {
    throw new Error(
      `Google Calendar did not return an event ID for booking ${bookingId}.`
    );
  }
  return eventId;
}

function eventDateTime(
  value: string | null | undefined,
  fallback: Date
): string {
  if (value && Number.isFinite(Date.parse(value))) return value;
  return fallback.toISOString();
}

async function withCalendarDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Calendar credential lookup timed out.")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bookingResultFromRow(booking: CalendarBookingRow): BookingResult {
  if (booking.status !== "confirmed" || !booking.google_event_id) {
    throw new Error(
      `Calendar booking ${booking.id} did not return confirmed event state.`
    );
  }
  return {
    eventId: booking.google_event_id,
    summary: booking.event_summary,
    startTime: booking.starts_at,
    endTime: booking.ends_at
  };
}

async function markCalendarBookingFailedBestEffort(
  businessId: string,
  bookingId: string,
  claimToken: string
): Promise<void> {
  const failureReason = "Google Calendar event creation was rejected.";
  try {
    const { error } = await supabaseAdmin.rpc("fail_calendar_booking", {
      p_business_id: businessId,
      p_booking_id: bookingId,
      p_claim_token: claimToken,
      p_failure_reason: failureReason.slice(0, 1000)
    });
    if (error) {
      console.error("[calendar] Booking failure-state update failed", {
        category: "database_response"
      });
    }
  } catch {
    console.error("[calendar] Booking failure-state update failed", {
      category: "database_exception"
    });
  }
}
