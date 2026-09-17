import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
  canUseFeature: vi.fn(),
  voiceAccess: vi.fn(),
  getAuthenticatedClient: vi.fn(),
  getCalendarService: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  submissionFenceRpc: vi.fn(),
  tokenSelect: vi.fn(),
  tokenBusinessEq: vi.fn(),
  tokenSingle: vi.fn(),
  bookingSelect: vi.fn(),
  bookingEq: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  serviceSelect: vi.fn(),
  serviceEq: vi.fn(),
  contactSelect: vi.fn(),
  contactEq: vi.fn(),
  contactSingle: vi.fn(),
  hoursSelect: vi.fn(),
  hoursEq: vi.fn(),
  hoursSingle: vi.fn(),
  eventsGet: vi.fn(),
  eventsList: vi.fn(),
  eventsInsert: vi.fn(),
  freeBusyQuery: vi.fn(),
  assertBookingOperationallyAllowed: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/voice/bookingAccess.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/bookingAccess.server")>()),
  validateVoiceBookingAccess: mocks.voiceAccess,
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: mocks.randomUUID
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
  canUseFeature: mocks.canUseFeature
}));
vi.mock("./client", () => ({
  getAuthenticatedClient: mocks.getAuthenticatedClient,
  getCalendarService: mocks.getCalendarService
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: (name: string, args: unknown) =>
      name === "mark_calendar_booking_submission_started"
        ? mocks.submissionFenceRpc(name, args)
        : mocks.rpc(name, args)
  }
}));
vi.mock("./bookingOperational.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./bookingOperational.server")>();
  return {
    ...actual,
    assertBookingOperationallyAllowed: mocks.assertBookingOperationallyAllowed
  };
});

import { OperationalControlsResolutionError } from "@/lib/account/operationalControls.server";
import { BookingOperationalBlockedError } from "./bookingOperational.server";
import {
  BookingSlotUnavailableError,
  CalendarBookingInProgressError,
  claimCalendarBookingReconciliation,
  createBooking,
  failCalendarBookingRecovery,
  recoverCalendarBookingConfirmation
} from "./calendar";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const SOURCE_MESSAGE_ID = "00000000-0000-4000-8000-000000000004";
const BOOKING_ID = "00000000-0000-4000-8000-000000000005";
const CALENDAR_ID = "connected-calendar";
const BUSINESS_TIMEZONE = "America/Indiana/Indianapolis";
const ORIGINAL_HOST_TIMEZONE = process.env.TZ;
const STARTS_AT = "2026-08-01T14:00:00.000Z";
const ENDS_AT = "2026-08-01T14:30:00.000Z";
const CURRENT_CLAIM = "00000000-0000-4000-8000-000000000006";
const OTHER_CLAIM = "00000000-0000-4000-8000-000000000007";

const params = {
  customerName: "Jane Customer",
  customerPhone: "+13175550123",
  customerEmail: "jane@example.com",
  serviceName: "Estimate",
  startTime: STARTS_AT,
  durationMinutes: 30
};

const linkage = {
  contactId: CONTACT_ID,
  conversationId: CONVERSATION_ID,
  sourceMessageId: SOURCE_MESSAGE_ID
};

function bookingFingerprint(
  bookingParams: {
    customerName: string;
    customerPhone?: string;
    customerEmail?: string;
    serviceName: string;
  },
  timezone: string,
  startsAt: string,
  endsAt: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        customerName: bookingParams.customerName.normalize("NFKC").trim(),
        customerPhone:
          bookingParams.customerPhone?.normalize("NFKC").trim() || null,
        customerEmail:
          bookingParams.customerEmail?.normalize("NFKC").trim().toLowerCase() ||
          null,
        serviceName: bookingParams.serviceName.normalize("NFKC").trim(),
        startTime: startsAt,
        endTime: endsAt,
        timezone
      })
    )
    .digest("hex");
}

const REQUEST_FINGERPRINT = bookingFingerprint(
  params,
  "UTC",
  STARTS_AT,
  ENDS_AT
);

function bookingRow(
  overrides: Partial<{
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
  }> = {}
) {
  return {
    id: BOOKING_ID,
    business_id: BUSINESS_ID,
    contact_id: CONTACT_ID,
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_MESSAGE_ID,
    google_calendar_id: CALENDAR_ID,
    google_event_id: null,
    event_summary: "Estimate - Jane Customer",
    request_fingerprint: REQUEST_FINGERPRINT,
    operation_claim_token: CURRENT_CLAIM,
    operation_claimed_at: "2026-08-01T13:59:00.000Z",
    reconciliation_attempt_count: 0,
    reconciliation_attempted_at: null,
    status: "pending" as const,
    starts_at: STARTS_AT,
    ends_at: ENDS_AT,
    ...overrides
  };
}

function googleEvent(
  id = "google-event-1",
  startsAt = STARTS_AT,
  endsAt = ENDS_AT
) {
  return {
    id,
    summary: "Estimate - Jane Customer",
    start: { dateTime: startsAt },
    end: { dateTime: endsAt },
    extendedProperties: {
      private: { simplassist_booking_id: BOOKING_ID }
    }
  };
}

async function book() {
  return createBooking(BUSINESS_ID, params, "UTC", linkage);
}

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
  vi.resetAllMocks();

  const tokenQuery = {
    select: mocks.tokenSelect,
    eq: mocks.tokenBusinessEq,
    single: mocks.tokenSingle
  };
  mocks.tokenSelect.mockReturnValue(tokenQuery);
  mocks.tokenBusinessEq.mockReturnValue(tokenQuery);
  mocks.tokenSingle.mockResolvedValue({
    data: {
      calendar_id: CALENDAR_ID,
      google_email: "owner@example.test"
    },
    error: null
  });

  const bookingQuery = {
    select: mocks.bookingSelect,
    eq: mocks.bookingEq,
    maybeSingle: mocks.bookingMaybeSingle
  };
  mocks.bookingSelect.mockReturnValue(bookingQuery);
  mocks.bookingEq.mockReturnValue(bookingQuery);
  mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });

  const serviceQuery = {
    select: mocks.serviceSelect,
    eq: mocks.serviceEq
  };
  mocks.serviceSelect.mockReturnValue(serviceQuery);
  mocks.serviceEq.mockImplementation((column: string) =>
    column === "is_active"
      ? Promise.resolve({
          data: [
            {
              id: "00000000-0000-4000-8000-000000000010",
              business_id: BUSINESS_ID,
              name: "Estimate",
              is_active: true
            },
            {
              id: "00000000-0000-4000-8000-000000000011",
              business_id: BUSINESS_ID,
              name: "Different Service",
              is_active: true
            }
          ],
          error: null
        })
      : serviceQuery
  );

  const contactQuery = {
    select: mocks.contactSelect,
    eq: mocks.contactEq,
    single: mocks.contactSingle
  };
  mocks.contactSelect.mockReturnValue(contactQuery);
  mocks.contactEq.mockReturnValue(contactQuery);
  mocks.contactSingle.mockResolvedValue({
    data: {
      id: CONTACT_ID,
      business_id: BUSINESS_ID,
      email: "jane@example.com"
    },
    error: null
  });

  const hoursQuery = {
    select: mocks.hoursSelect,
    eq: mocks.hoursEq,
    single: mocks.hoursSingle
  };
  mocks.hoursSelect.mockReturnValue(hoursQuery);
  mocks.hoursEq.mockReturnValue(hoursQuery);
  mocks.hoursSingle.mockResolvedValue({
    data: {
      id: "00000000-0000-4000-8000-000000000012",
      business_id: BUSINESS_ID,
      day_of_week: 6,
      open_time: "00:00:00",
      close_time: "23:59:00",
      is_closed: false
    },
    error: null
  });

  mocks.from.mockImplementation((table: string) => {
    if (table === "calendar_bookings") return bookingQuery;
    if (table === "google_calendar_tokens") return tokenQuery;
    if (table === "services") return serviceQuery;
    if (table === "contacts") return contactQuery;
    if (table === "business_hours") return hoursQuery;
    throw new Error(`Unexpected Supabase table: ${table}`);
  });

  mocks.resolveBusinessEntitlements.mockResolvedValue({
    businessId: BUSINESS_ID,
    plan: "full",
    status: "active",
    source: "subscription",
    active: true,
    cancelAtPeriodEnd: false
  });
  mocks.canUseFeature.mockReturnValue(true);
  mocks.getAuthenticatedClient.mockResolvedValue({ credentials: {} });
  mocks.getCalendarService.mockReturnValue({
    freebusy: {
      query: mocks.freeBusyQuery
    },
    events: {
      get: mocks.eventsGet,
      list: mocks.eventsList,
      insert: mocks.eventsInsert
    }
  });
  mocks.randomUUID.mockReturnValue(CURRENT_CLAIM);
  mocks.submissionFenceRpc.mockResolvedValue({
    data: bookingRow({
      operation_claim_token: CURRENT_CLAIM,
      operation_claimed_at: "2026-07-01T12:00:01.000Z"
    }),
    error: null
  });
  mocks.assertBookingOperationallyAllowed.mockResolvedValue(undefined);
  mocks.voiceAccess.mockResolvedValue({ email: params.customerEmail });
  mocks.eventsGet.mockRejectedValue({ response: { status: 404 } });
  mocks.eventsList.mockResolvedValue({ data: { items: [] } });
  mocks.eventsInsert.mockResolvedValue({ data: googleEvent() });
  mocks.freeBusyQuery.mockResolvedValue({
    data: { calendars: { [CALENDAR_ID]: { busy: [] } } }
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (ORIGINAL_HOST_TIMEZONE === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_HOST_TIMEZONE;
  }
});

describe("createBooking lifecycle", () => {
  it("books voice-confirmed details and invites the current call email without overwriting a conflicting contact", async () => {
    const voice = { sessionId: "voice-session", actionId: "voice-action" };
    const voiceParams = { ...params, startTime: "2026-08-01T14:00:00" };
    mocks.contactSingle.mockResolvedValue({
      data: { id: CONTACT_ID, business_id: BUSINESS_ID, email: "older@example.com" },
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({ data: bookingRow({ status: "confirmed", google_event_id: "google-event-1", operation_claim_token: null, operation_claimed_at: null }), error: null });

    await expect(createBooking(BUSINESS_ID, voiceParams, "UTC", linkage, voice))
      .resolves.toMatchObject({ eventId: "google-event-1" });
    expect(mocks.voiceAccess).toHaveBeenCalledTimes(2);
    expect(mocks.voiceAccess).toHaveBeenLastCalledWith(BUSINESS_ID, voice, SOURCE_MESSAGE_ID, voiceParams);
    expect(mocks.voiceAccess.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.submissionFenceRpc.mock.invocationCallOrder[0]);
    expect(mocks.voiceAccess.mock.invocationCallOrder[1]).toBeLessThan(mocks.eventsInsert.mock.invocationCallOrder[0]);
    expect(mocks.eventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      sendUpdates: "all",
      requestBody: expect.objectContaining({ attendees: [{ email: "jane@example.com" }] }),
    }), { retry: false, timeout: 60_000 });
  });

  it("releases its reservation without inserting when a voice confirmation is superseded during calendar checks", async () => {
    mocks.voiceAccess.mockResolvedValueOnce({ email: params.customerEmail })
      .mockRejectedValueOnce(new Error("voice_booking_confirmation_superseded"));
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({ data: bookingRow({ status: "failed", operation_claim_token: null, operation_claimed_at: null }), error: null });

    await expect(createBooking(BUSINESS_ID, { ...params, startTime: "2026-08-01T14:00:00" }, "UTC", linkage,
      { sessionId: "voice-session", actionId: "voice-action" }))
      .rejects.toThrow("voice_booking_authority_changed_before_submission");
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith("fail_calendar_booking", expect.objectContaining({
      p_business_id: BUSINESS_ID, p_booking_id: BOOKING_ID, p_claim_token: CURRENT_CLAIM,
    }));
  });

  it("does not fabricate a clean no-submit outcome if reservation cleanup cannot be verified", async () => {
    mocks.voiceAccess.mockResolvedValueOnce({ email: params.customerEmail })
      .mockRejectedValueOnce(new Error("voice_booking_not_authorized"));
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(createBooking(BUSINESS_ID, { ...params, startTime: "2026-08-01T14:00:00" }, "UTC", linkage,
      { sessionId: "voice-session", actionId: "voice-action" }))
      .rejects.not.toThrow("voice_booking_authority_changed_before_submission");
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("interprets an offsetless booking as Indianapolis wall time and submits ISO instants to Google", async () => {
    const localParams = {
      ...params,
      startTime: "2026-08-01T10:00:00"
    };
    const requestFingerprint = bookingFingerprint(
      localParams,
      BUSINESS_TIMEZONE,
      STARTS_AT,
      ENDS_AT
    );
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({ request_fingerprint: requestFingerprint }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          request_fingerprint: requestFingerprint,
          status: "confirmed"
        }),
        error: null
      });

    await expect(
      createBooking(BUSINESS_ID, localParams, BUSINESS_TIMEZONE, linkage)
    ).resolves.toEqual({
      eventId: "google-event-1",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "reserve_calendar_booking",
      expect.objectContaining({
        p_starts_at: STARTS_AT,
        p_ends_at: ENDS_AT,
        p_request_fingerprint: requestFingerprint
      })
    );
    expect(mocks.eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          start: {
            dateTime: STARTS_AT,
            timeZone: BUSINESS_TIMEZONE
          },
          end: {
            dateTime: ENDS_AT,
            timeZone: BUSINESS_TIMEZONE
          }
        })
      }),
      { retry: false, timeout: 60_000 }
    );
  });

  it("honors an offset-qualified booking as an absolute instant", async () => {
    const offsetParams = {
      ...params,
      startTime: "2026-08-01T10:00:00-07:00"
    };
    const qualifiedStartsAt = "2026-08-01T17:00:00.000Z";
    const qualifiedEndsAt = "2026-08-01T17:30:00.000Z";
    const requestFingerprint = bookingFingerprint(
      offsetParams,
      BUSINESS_TIMEZONE,
      qualifiedStartsAt,
      qualifiedEndsAt
    );
    mocks.eventsInsert.mockResolvedValueOnce({
      data: googleEvent("google-event-1", qualifiedStartsAt, qualifiedEndsAt)
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({
          starts_at: qualifiedStartsAt,
          ends_at: qualifiedEndsAt,
          request_fingerprint: requestFingerprint
        }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          request_fingerprint: requestFingerprint,
          starts_at: qualifiedStartsAt,
          ends_at: qualifiedEndsAt,
          status: "confirmed"
        }),
        error: null
      });

    await expect(
      createBooking(BUSINESS_ID, offsetParams, BUSINESS_TIMEZONE, linkage)
    ).resolves.toEqual({
      eventId: "google-event-1",
      summary: "Estimate - Jane Customer",
      startTime: qualifiedStartsAt,
      endTime: qualifiedEndsAt
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "reserve_calendar_booking",
      expect.objectContaining({
        p_starts_at: qualifiedStartsAt,
        p_ends_at: qualifiedEndsAt
      })
    );
    expect(mocks.eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          start: {
            dateTime: qualifiedStartsAt,
            timeZone: BUSINESS_TIMEZONE
          },
          end: {
            dateTime: qualifiedEndsAt,
            timeZone: BUSINESS_TIMEZONE
          }
        })
      }),
      { retry: false, timeout: 60_000 }
    );
  });

  it.each(["2026-02-29T10:00:00Z", "2026-04-31T10:00:00-04:00"])(
    "rejects an impossible offset-qualified calendar date without coercing it: %s",
    async (startTime) => {
      await expect(
        createBooking(
          BUSINESS_ID,
          { ...params, startTime },
          BUSINESS_TIMEZONE,
          linkage
        )
      ).rejects.toThrow(
        "Appointment start time contains an invalid calendar date."
      );

      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.eventsGet).not.toHaveBeenCalled();
      expect(mocks.eventsList).not.toHaveBeenCalled();
      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["invalid", "Definitely/Not_A_Timezone"]
  ])(
    "rejects a %s business timezone before reservation or provider mutation",
    async (_name, timezone) => {
      await expect(
        createBooking(BUSINESS_ID, params, timezone as string, linkage)
      ).rejects.toThrow(
        "A valid IANA business timezone is required to create a booking."
      );

      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.eventsGet).not.toHaveBeenCalled();
      expect(mocks.eventsList).not.toHaveBeenCalled();
      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["customer name", { ...params, customerName: "x".repeat(201) }],
    ["customer name", { ...params, customerName: "Jane\nAttacker" }],
    ["service name", { ...params, serviceName: "x".repeat(201) }],
    ["customer phone", { ...params, customerPhone: "1".repeat(51) }],
    ["customer email", { ...params, customerEmail: "not-an-email" }],
    [
      "customer email",
      { ...params, customerEmail: `${"a".repeat(243)}@example.com` }
    ],
    ["start time", { ...params, startTime: "x".repeat(65) }]
  ])(
    "rejects an invalid or oversized %s before catalog, OAuth, reservation, or provider work",
    async (_label, invalidParams) => {
      await expect(
        createBooking(BUSINESS_ID, invalidParams, "UTC", linkage)
      ).rejects.toThrow(/valid|required/i);

      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    }
  );

  it.each([0, 29, 31, 241, 30.5, Number.NaN])(
    "rejects the invalid booking duration %s before side effects",
    async (durationMinutes) => {
      await expect(
        createBooking(
          BUSINESS_ID,
          { ...params, durationMinutes },
          "UTC",
          linkage
        )
      ).rejects.toThrow(
        "Booking duration must be between 30 and 240 minutes in 30-minute increments."
      );

      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it("accepts the conservative 240-minute duration ceiling", async () => {
    const longParams = { ...params, durationMinutes: 240 };
    const longEnd = "2026-08-01T18:00:00.000Z";
    const fingerprint = bookingFingerprint(
      longParams,
      "UTC",
      STARTS_AT,
      longEnd
    );
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({
        google_event_id: "existing-event",
        operation_claim_token: null,
        operation_claimed_at: null,
        request_fingerprint: fingerprint,
        ends_at: longEnd,
        status: "confirmed"
      }),
      error: null
    });

    await expect(
      createBooking(BUSINESS_ID, longParams, "UTC", linkage)
    ).resolves.toMatchObject({
      eventId: "existing-event",
      startTime: STARTS_AT,
      endTime: longEnd
    });
  });

  it("rejects starts that do not align to a 30-minute boundary", async () => {
    await expect(
      createBooking(
        BUSINESS_ID,
        { ...params, startTime: "2026-08-01T14:15:00Z" },
        "UTC",
        linkage
      )
    ).rejects.toThrow("must align to a 30-minute boundary");

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("calendar_bookings");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("enforces the default 60-minute minimum lead time", async () => {
    vi.setSystemTime(new Date("2026-08-01T13:30:00.000Z"));

    await expect(book()).rejects.toThrow(
      "Appointment start time must be at least 60 minutes in the future."
    );
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("calendar_bookings");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("enforces the default 90-day booking horizon", async () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    await expect(book()).rejects.toThrow(
      "Appointment start time is outside the booking horizon."
    );
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("calendar_bookings");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["CALENDAR_BOOKING_MIN_LEAD_MINUTES", "sixty"],
    ["CALENDAR_BOOKING_MIN_LEAD_MINUTES", "43201"],
    ["CALENDAR_BOOKING_MAX_HORIZON_DAYS", "0"],
    ["CALENDAR_BOOKING_MAX_HORIZON_DAYS", "366"]
  ])("fails closed for malformed %s=%s", async (name, value) => {
    vi.stubEnv(name, value);

    await expect(book()).rejects.toThrow(
      `Invalid ${name} calendar configuration.`
    );
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("calendar_bookings");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires the requested name to resolve to one active catalog service", async () => {
    mocks.serviceEq.mockImplementation((column: string) =>
      column === "is_active"
        ? Promise.resolve({ data: [], error: null })
        : { eq: mocks.serviceEq }
    );

    await expect(book()).rejects.toThrow(
      "must match one active service in the business catalog"
    );
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed if catalog data ambiguously resolves the same normalized service", async () => {
    mocks.serviceEq.mockImplementation((column: string) =>
      column === "is_active"
        ? Promise.resolve({
            data: [
              {
                id: "00000000-0000-4000-8000-000000000010",
                business_id: BUSINESS_ID,
                name: "Estimate",
                is_active: true
              },
              {
                id: "00000000-0000-4000-8000-000000000011",
                business_id: BUSINESS_ID,
                name: " estimate ",
                is_active: true
              }
            ],
            error: null
          })
        : { eq: mocks.serviceEq }
    );

    await expect(book()).rejects.toThrow(
      "must match one active service in the business catalog"
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a tool-supplied invite email that is not the persisted linked-contact email", async () => {
    mocks.contactSingle.mockResolvedValueOnce({
      data: {
        id: CONTACT_ID,
        business_id: BUSINESS_ID,
        email: "different@example.com"
      },
      error: null
    });

    await expect(book()).rejects.toThrow(
      "only be sent to the validated email saved on this contact"
    );
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("normalizes a persisted matching email and uses the canonical catalog name", async () => {
    const normalizedParams = {
      ...params,
      customerName: "  Jane   Customer  ",
      customerEmail: "  JANE@EXAMPLE.COM  ",
      serviceName: "  estimate  "
    };
    const fingerprint = bookingFingerprint(
      normalizedParams,
      "UTC",
      STARTS_AT,
      ENDS_AT
    );
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({ request_fingerprint: fingerprint }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          request_fingerprint: fingerprint,
          status: "confirmed"
        }),
        error: null
      });

    await expect(
      createBooking(BUSINESS_ID, normalizedParams, "UTC", linkage)
    ).resolves.toMatchObject({ summary: "Estimate - Jane Customer" });
    expect(mocks.eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          summary: "Estimate - Jane Customer",
          attendees: [{ email: "jane@example.com" }]
        })
      }),
      { retry: false, timeout: 60_000 }
    );
  });

  it("does not invite even a persisted contact email unless the confirmed tool input includes it", async () => {
    const noEmailParams = { ...params, customerEmail: undefined };
    const fingerprint = bookingFingerprint(
      noEmailParams,
      "UTC",
      STARTS_AT,
      ENDS_AT
    );
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({ request_fingerprint: fingerprint }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          request_fingerprint: fingerprint,
          status: "confirmed"
        }),
        error: null
      });

    await createBooking(BUSINESS_ID, noEmailParams, "UTC", linkage);

    const inserted = mocks.eventsInsert.mock.calls[0]?.[0] as
      | { requestBody?: Record<string, unknown> }
      | undefined;
    expect(inserted?.requestBody).not.toHaveProperty("attendees");
  });

  it.each([
    ["closed", { is_closed: true }],
    ["before opening", { open_time: "15:00:00" }],
    ["after closing", { close_time: "14:15:00" }]
  ])(
    "rejects a booking when configured hours are %s",
    async (_label, override) => {
      mocks.hoursSingle.mockResolvedValueOnce({
        data: {
          id: "00000000-0000-4000-8000-000000000012",
          business_id: BUSINESS_ID,
          day_of_week: 6,
          open_time: "00:00:00",
          close_time: "23:59:00",
          is_closed: false,
          ...override
        },
        error: null
      });

      await expect(book()).rejects.toThrow(/closed|business hours/i);
      expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it("rechecks free/busy immediately before insert and releases a newly conflicted slot", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "failed"
        }),
        error: null
      });
    mocks.freeBusyQuery.mockResolvedValueOnce({
      data: {
        calendars: {
          [CALENDAR_ID]: {
            busy: [{ start: STARTS_AT, end: ENDS_AT }]
          }
        }
      }
    });

    await expect(book()).rejects.toBeInstanceOf(BookingSlotUnavailableError);
    expect(mocks.freeBusyQuery).toHaveBeenCalledWith(
      {
        requestBody: {
          timeMin: STARTS_AT,
          timeMax: ENDS_AT,
          timeZone: "UTC",
          items: [{ id: CALENDAR_ID }]
        }
      },
      { retry: false, timeout: 10_000 }
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason:
        "The requested appointment time was no longer available."
    });
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("surfaces a concurrently reserved local slot before any Google request", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23P01",
        message: "calendar_booking_slot_unavailable"
      }
    });

    await expect(book()).rejects.toBeInstanceOf(BookingSlotUnavailableError);

    expect(mocks.eventsGet).not.toHaveBeenCalled();
    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("fails closed without inserting or falsely releasing the reservation when free/busy is indeterminate", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null });
    mocks.freeBusyQuery.mockResolvedValueOnce({
      data: { calendars: {} }
    });

    await expect(book()).rejects.toThrow(
      "Google Calendar availability could not be verified."
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "fail_calendar_booking",
      expect.anything()
    );
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("returns a durably confirmed booking even after its start time has passed and catalog policy changed", async () => {
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    mocks.bookingMaybeSingle.mockResolvedValueOnce({
      data: bookingRow({
        google_event_id: "existing-event",
        operation_claim_token: null,
        operation_claimed_at: null,
        status: "confirmed"
      }),
      error: null
    });
    mocks.serviceEq.mockImplementation((column: string) =>
      column === "is_active"
        ? Promise.resolve({ data: [], error: null })
        : { eq: mocks.serviceEq }
    );

    await expect(book()).resolves.toEqual({
      eventId: "existing-event",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.serviceSelect).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("fails closed before catalog or provider work when existing booking state cannot be read", async () => {
    mocks.bookingMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "database offline" }
    });

    await expect(book()).rejects.toThrow(
      "Could not check existing calendar booking state."
    );
    expect(mocks.serviceSelect).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant existing booking state before provider work", async () => {
    mocks.bookingMaybeSingle.mockResolvedValueOnce({
      data: {
        ...bookingRow(),
        business_id: "00000000-0000-4000-8000-000000000099"
      },
      error: null
    });

    await expect(book()).rejects.toThrow(
      "returned inconsistent tenant or linkage data"
    );
    expect(mocks.serviceSelect).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("converges pending provider evidence before applying changed time or catalog policy", async () => {
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    const pending = bookingRow({ operation_claim_token: OTHER_CLAIM });
    mocks.bookingMaybeSingle.mockResolvedValueOnce({
      data: pending,
      error: null
    });
    mocks.eventsList.mockResolvedValueOnce({
      data: { items: [googleEvent("recovered-event")] }
    });
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({
        google_event_id: "recovered-event",
        operation_claim_token: null,
        operation_claimed_at: null,
        status: "confirmed"
      }),
      error: null
    });
    mocks.serviceEq.mockImplementation((column: string) =>
      column === "is_active"
        ? Promise.resolve({ data: [], error: null })
        : { eq: mocks.serviceEq }
    );

    await expect(book()).resolves.toMatchObject({
      eventId: "recovered-event"
    });
    expect(mocks.eventsList).toHaveBeenCalledWith(
      {
        calendarId: CALENDAR_ID,
        maxResults: 1,
        showDeleted: false,
        singleEvents: true,
        privateExtendedProperty: [`simplassist_booking_id=${BOOKING_ID}`]
      },
      { retry: false, timeout: 10_000 }
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "confirm_calendar_booking",
      expect.objectContaining({ p_claim_token: OTHER_CLAIM })
    );
    expect(mocks.serviceSelect).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "account suspension",
      new BookingOperationalBlockedError(BUSINESS_ID, "account_suspended")
    ],
    [
      "booking pause",
      new BookingOperationalBlockedError(BUSINESS_ID, "bookings_paused")
    ]
  ])(
    "blocks entry on %s before entitlement, token, reservation, or Google work",
    async (_name, error) => {
      mocks.assertBookingOperationallyAllowed.mockRejectedValueOnce(error);

      await expect(book()).rejects.toBe(error);

      expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
      expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.eventsGet).not.toHaveBeenCalled();
      expect(mocks.eventsList).not.toHaveBeenCalled();
      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    }
  );

  it("preserves entry resolver uncertainty before any booking side effect", async () => {
    const error = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "database unavailable"
    });
    mocks.assertBookingOperationallyAllowed.mockRejectedValueOnce(error);

    await expect(book()).rejects.toBe(error);

    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("reserves before Google, tags the event, and confirms the reservation", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });

    await expect(book()).resolves.toEqual({
      eventId: "google-event-1",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "reserve_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_contact_id: CONTACT_ID,
      p_conversation_id: CONVERSATION_ID,
      p_source_message_id: SOURCE_MESSAGE_ID,
      p_starts_at: STARTS_AT,
      p_ends_at: ENDS_AT,
      p_claim_token: CURRENT_CLAIM,
      p_google_calendar_id: CALENDAR_ID,
      p_event_summary: "Estimate - Jane Customer",
      p_request_fingerprint: REQUEST_FINGERPRINT
    });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.eventsList.mock.invocationCallOrder[0]
    );
    expect(mocks.tokenSelect).toHaveBeenCalledWith(
      "calendar_id, google_email"
    );
    expect(mocks.getAuthenticatedClient).toHaveBeenCalledTimes(2);
    expect(
      mocks.getAuthenticatedClient.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getAuthenticatedClient.mock.invocationCallOrder[1]
    );
    expect(mocks.eventsList).toHaveBeenCalledWith(
      {
        calendarId: CALENDAR_ID,
        maxResults: 1,
        showDeleted: false,
        singleEvents: true,
        privateExtendedProperty: [`simplassist_booking_id=${BOOKING_ID}`]
      },
      { retry: false, timeout: 10_000 }
    );
    expect(mocks.eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: CALENDAR_ID,
        sendUpdates: "all",
        requestBody: expect.objectContaining({
          id: BOOKING_ID.replaceAll("-", ""),
          extendedProperties: {
            private: {
              simplassist_booking_id: BOOKING_ID,
              simplassist_business_id: BUSINESS_ID,
              simplassist_contact_id: CONTACT_ID,
              simplassist_conversation_id: CONVERSATION_ID,
              simplassist_source_message_id: SOURCE_MESSAGE_ID,
              simplassist_service_id: "00000000-0000-4000-8000-000000000010"
            }
          }
        })
      }),
      { retry: false, timeout: 60_000 }
    );
    const insertedRequest = mocks.eventsInsert.mock.calls[0]?.[0] as
      | { requestBody?: { description?: string } }
      | undefined;
    expect(insertedRequest?.requestBody?.description).toContain(
      "Booked via AI assistant"
    );
    expect(insertedRequest?.requestBody?.description).not.toContain(
      "SimplAssist"
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "confirm_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_google_event_id: "google-event-1",
      p_starts_at: STARTS_AT,
      p_ends_at: ENDS_AT,
      p_claim_token: CURRENT_CLAIM
    });
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(2);
    expect(mocks.freeBusyQuery).toHaveBeenCalledWith(
      {
        requestBody: {
          timeMin: STARTS_AT,
          timeMax: ENDS_AT,
          timeZone: "UTC",
          items: [{ id: CALENDAR_ID }]
        }
      },
      { retry: false, timeout: 10_000 }
    );
    expect(mocks.freeBusyQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.eventsInsert.mock.invocationCallOrder[0]
    );
    expect(
      mocks.assertBookingOperationallyAllowed.mock.invocationCallOrder[1]
    ).toBeLessThan(mocks.eventsInsert.mock.invocationCallOrder[0]);
    expect(mocks.submissionFenceRpc).toHaveBeenCalledWith(
      "mark_calendar_booking_submission_started",
      {
        p_business_id: BUSINESS_ID,
        p_booking_id: BOOKING_ID,
        p_claim_token: CURRENT_CLAIM,
        p_expected_claimed_at: "2026-08-01T13:59:00.000Z"
      }
    );
    expect(
      mocks.submissionFenceRpc.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.eventsInsert.mock.invocationCallOrder[0]);
  });

  it("does not insert when reconciliation wins the claimed-at submission CAS", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null });
    mocks.submissionFenceRpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "calendar booking submission claim mismatch"
      }
    });

    await expect(book()).rejects.toBeInstanceOf(
      CalendarBookingInProgressError
    );
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("fails the pre-submit reservation if the provider namespace changes", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          status: "failed",
          operation_claim_token: null,
          operation_claimed_at: null
        }),
        error: null
      });
    mocks.tokenSingle
      .mockResolvedValueOnce({
        data: {
          calendar_id: CALENDAR_ID,
          google_email: "owner-a@example.test"
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          calendar_id: CALENDAR_ID,
          google_email: "owner-b@example.test"
        },
        error: null
      });

    await expect(book()).rejects.toThrow(
      "Google Calendar connection changed. Please retry."
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason:
        "Booking was blocked before Google Calendar submission."
    });
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("releases a new reservation when post-hold credential reload fails", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          status: "failed",
          operation_claim_token: null,
          operation_claimed_at: null
        }),
        error: null
      });
    mocks.getAuthenticatedClient
      .mockResolvedValueOnce({ credentials: {} })
      .mockRejectedValueOnce(new Error("transient refresh failure"));

    await expect(book()).rejects.toThrow(
      "Google Calendar credentials are temporarily unavailable."
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason:
        "Booking was blocked before Google Calendar submission."
    });
    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("maps a reservation fence denial to the fresh known booking block", async () => {
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(blocked);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "calendar booking business is not active" }
    });

    await expect(book()).rejects.toBe(blocked);

    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(2);
    expect(mocks.eventsGet).not.toHaveBeenCalled();
    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("preserves resolver uncertainty while interpreting a reservation fence denial", async () => {
    const uncertain = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "database unavailable"
    });
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(uncertain);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "calendar booking business is not active" }
    });

    await expect(book()).rejects.toBe(uncertain);

    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("fails a claimed reservation before Google when booking pauses after recovery search", async () => {
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(blocked);
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "failed"
        }),
        error: null
      });

    await expect(book()).rejects.toBe(blocked);

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason: "Booking was blocked before Google Calendar submission."
    });
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("leaves the claim pending for reconciliation when the final control read is indeterminate", async () => {
    const uncertain = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "database unavailable"
    });
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(uncertain);
    mocks.rpc.mockResolvedValueOnce({ data: bookingRow(), error: null });

    await expect(book()).rejects.toBe(uncertain);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "fail_calendar_booking",
      expect.anything()
    );
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it.each([
    ["database error", { data: null, error: { message: "database offline" } }],
    ["malformed row", { data: { status: "failed" }, error: null }],
    ["still-pending row", { data: bookingRow(), error: null }],
    [
      "failed row with a live claim",
      { data: bookingRow({ status: "failed" }), error: null }
    ],
    [
      "confirmed row without a provider ID",
      {
        data: bookingRow({
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      }
    ]
  ])(
    "surfaces typed retryable state uncertainty when pause cleanup returns a %s",
    async (_name, cleanupResult) => {
      const blocked = new BookingOperationalBlockedError(
        BUSINESS_ID,
        "bookings_paused"
      );
      mocks.assertBookingOperationallyAllowed
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);
      mocks.rpc
        .mockResolvedValueOnce({ data: bookingRow(), error: null })
        .mockResolvedValueOnce(cleanupResult);

      await expect(book()).rejects.toMatchObject({
        name: "BookingOperationalStateError",
        code: "booking_cleanup_failed",
        businessId: BUSINESS_ID,
        retryable: true
      });

      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    }
  );

  it("surfaces typed retryable state uncertainty when pause cleanup throws", async () => {
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    const cleanupError = new Error("connection dropped");
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(blocked);
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockRejectedValueOnce(cleanupError);

    await expect(book()).rejects.toMatchObject({
      name: "BookingOperationalStateError",
      code: "booking_cleanup_failed",
      businessId: BUSINESS_ID,
      retryable: true,
      cause: cleanupError
    });

    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("returns a concurrent confirmed result when confirmation wins the pause-cleanup race", async () => {
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "account_suspended"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(blocked);
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "concurrent-event",
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });

    await expect(book()).resolves.toEqual({
      eventId: "concurrent-event",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("short-circuits with stored event details when a duplicate tool call changes input", async () => {
    const laterPause = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(laterPause);
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({
        google_event_id: "existing-event",
        operation_claim_token: null,
        operation_claimed_at: null,
        status: "confirmed"
      }),
      error: null
    });

    await expect(
      createBooking(
        BUSINESS_ID,
        {
          ...params,
          customerName: "Different Name",
          serviceName: "Different Service"
        },
        "UTC",
        linkage
      )
    ).resolves.toEqual({
      eventId: "existing-event",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(1);
  });

  it("refuses to create when pending source-message details change", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow(),
      error: null
    });

    await expect(
      createBooking(
        BUSINESS_ID,
        { ...params, serviceName: "Different Service" },
        "UTC",
        linkage
      )
    ).rejects.toThrow("replayed with different booking details");

    expect(mocks.eventsGet).not.toHaveBeenCalled();
    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("recovers existing provider evidence after an allowed entry without applying the new-insert pause gate", async () => {
    const laterPause = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(laterPause);
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({ operation_claim_token: OTHER_CLAIM }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "recovered-event",
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });
    mocks.eventsList.mockResolvedValueOnce({
      data: { items: [googleEvent("recovered-event")] }
    });

    await expect(book()).resolves.toEqual({
      eventId: "recovered-event",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.eventsInsert).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "confirm_calendar_booking",
      expect.objectContaining({ p_claim_token: OTHER_CLAIM })
    );
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(1);
  });

  it("recovers from the reservation's original calendar after selection changes", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow({
          google_calendar_id: "original-calendar",
          operation_claim_token: OTHER_CLAIM
        }),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_calendar_id: "original-calendar",
          google_event_id: BOOKING_ID.replaceAll("-", ""),
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });
    mocks.eventsGet.mockResolvedValueOnce({
      data: googleEvent(BOOKING_ID.replaceAll("-", ""))
    });

    await expect(book()).resolves.toMatchObject({
      eventId: BOOKING_ID.replaceAll("-", "")
    });

    expect(mocks.eventsGet).toHaveBeenCalledWith(
      {
        calendarId: "original-calendar",
        eventId: BOOKING_ID.replaceAll("-", "")
      },
      { retry: false, timeout: 10_000 }
    );
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it("does not insert when another caller owns a fresh pending claim", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({ operation_claim_token: OTHER_CLAIM }),
      error: null
    });

    await expect(book()).rejects.toEqual(
      new CalendarBookingInProgressError(BOOKING_ID)
    );

    expect(mocks.eventsList).toHaveBeenCalledTimes(1);
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails only its claimed pending reservation for a definitive Google rejection", async () => {
    const providerError = Object.assign(
      new Error("Google rejected the event payload"),
      { response: { status: 400 } }
    );
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow(),
        error: null
      })
      .mockResolvedValueOnce({ data: null, error: null });
    mocks.eventsInsert.mockRejectedValueOnce(providerError);

    await expect(book()).rejects.toBe(providerError);

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason: "Google Calendar event creation was rejected."
    });
  });

  it("keeps an ambiguous Google failure pending when recovery finds no event", async () => {
    const providerError = new Error("Google insert timed out");
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow(),
      error: null
    });
    mocks.eventsInsert.mockRejectedValueOnce(providerError);

    await expect(book()).rejects.toBe(providerError);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "fail_calendar_booking",
      expect.anything()
    );
  });

  it.each([425, 499])(
    "keeps provider HTTP %s pending because it cannot prove insert absence",
    async (status) => {
      const providerError = Object.assign(
        new Error("provider request outcome unknown"),
        { response: { status } }
      );
      mocks.rpc.mockResolvedValueOnce({
        data: bookingRow(),
        error: null
      });
      mocks.eventsInsert.mockRejectedValueOnce(providerError);

      await expect(book()).rejects.toBe(providerError);

      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "fail_calendar_booking",
        expect.anything()
      );
    }
  );

  it("does not log provider details when insert recovery also fails", async () => {
    const insertError = new Error("Google insert timed out");
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow(),
      error: null
    });
    mocks.eventsGet
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce(
        new Error("jane@example.com authorization=secret")
      );
    mocks.eventsInsert.mockRejectedValueOnce(insertError);

    await expect(book()).rejects.toBe(insertError);

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("jane@example.com");
    expect(logged).not.toContain("authorization");
    expect(logged).not.toContain("secret");
    expect(console.error).toHaveBeenCalledWith(
      `[calendar] Could not reconcile ambiguous Google insert for booking ${BOOKING_ID}`
    );
  });

  it("recovers an ambiguous Google failure by deterministic event ID", async () => {
    const providerError = new Error("Google insert timed out");
    const pauseAfterProviderSubmission = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    mocks.assertBookingOperationallyAllowed
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(pauseAfterProviderSubmission);
    mocks.rpc
      .mockResolvedValueOnce({
        data: bookingRow(),
        error: null
      })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: BOOKING_ID.replaceAll("-", ""),
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });
    mocks.eventsGet
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        data: googleEvent(BOOKING_ID.replaceAll("-", ""))
      });
    mocks.eventsInsert.mockRejectedValueOnce(providerError);

    await expect(book()).resolves.toEqual({
      eventId: BOOKING_ID.replaceAll("-", ""),
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "confirm_calendar_booking",
      expect.objectContaining({
        p_google_event_id: BOOKING_ID.replaceAll("-", "")
      })
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "fail_calendar_booking",
      expect.anything()
    );
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(2);
  });

  it("leaves a successful Google insert pending so a retry can recover it", async () => {
    mocks.randomUUID
      .mockReturnValueOnce(CURRENT_CLAIM)
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000008");
    mocks.rpc
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "database unavailable after Google insert" }
      })
      .mockResolvedValueOnce({ data: bookingRow(), error: null })
      .mockResolvedValueOnce({
        data: bookingRow({
          google_event_id: "google-event-1",
          operation_claim_token: null,
          operation_claimed_at: null,
          status: "confirmed"
        }),
        error: null
      });
    mocks.eventsList
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({
        data: { items: [googleEvent()] }
      });

    await expect(book()).rejects.toThrow(
      "Could not confirm calendar booking: database unavailable after Google insert"
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(2);

    await expect(book()).resolves.toEqual({
      eventId: "google-event-1",
      summary: "Estimate - Jane Customer",
      startTime: STARTS_AT,
      endTime: ENDS_AT
    });

    expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
    expect(mocks.eventsList).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      4,
      "confirm_calendar_booking",
      expect.objectContaining({
        p_booking_id: BOOKING_ID,
        p_google_event_id: "google-event-1",
        p_claim_token: CURRENT_CLAIM
      })
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      name: "cancelled deterministic event",
      providerResult: {
        kind: "resolved" as const,
        value: {
          data: {
            ...googleEvent(BOOKING_ID.replaceAll("-", "")),
            status: "cancelled"
          }
        }
      }
    },
    {
      name: "410-deleted deterministic event",
      providerResult: {
        kind: "rejected" as const,
        value: { response: { status: 410 } }
      }
    }
  ])(
    "does not confirm a $name during stale-claim recovery",
    async ({ providerResult }) => {
      const pending = bookingRow();
      if (providerResult.kind === "resolved") {
        mocks.eventsGet.mockResolvedValueOnce(providerResult.value);
      } else {
        mocks.eventsGet.mockRejectedValueOnce(providerResult.value);
      }
      mocks.eventsList.mockResolvedValueOnce({ data: { items: [] } });

      await expect(recoverCalendarBookingConfirmation(pending)).resolves.toBe(
        false
      );

      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "confirm_calendar_booking",
        expect.anything()
      );
    }
  );

  it("releases a stale reservation whose Google event is still missing", async () => {
    const pending = bookingRow();
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({
        operation_claim_token: null,
        operation_claimed_at: null,
        status: "failed"
      }),
      error: null
    });

    await expect(failCalendarBookingRecovery(pending)).resolves.toBe("failed");

    expect(mocks.rpc).toHaveBeenCalledWith("fail_calendar_booking", {
      p_business_id: BUSINESS_ID,
      p_booking_id: BOOKING_ID,
      p_claim_token: CURRENT_CLAIM,
      p_failure_reason:
        "Google Calendar event was not found during booking reconciliation."
    });
  });

  it("atomically renews a stale claim before provider reconciliation", async () => {
    const pending = bookingRow();
    mocks.rpc.mockResolvedValueOnce({
      data: bookingRow({
        operation_claimed_at: "2026-08-01T14:10:00.000Z",
        reconciliation_attempt_count: 1,
        reconciliation_attempted_at: "2026-08-01T14:10:00.000Z"
      }),
      error: null
    });

    await expect(
      claimCalendarBookingReconciliation(pending)
    ).resolves.toMatchObject({
      status: "pending",
      reconciliation_attempt_count: 1
    });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_calendar_booking_reconciliation",
      {
        p_business_id: BUSINESS_ID,
        p_booking_id: BOOKING_ID,
        p_claim_token: CURRENT_CLAIM
      }
    );
  });
});
