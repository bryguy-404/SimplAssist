import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertBookingOperationallyAllowed: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
  canUseFeature: vi.fn(),
  getAuthenticatedClient: vi.fn(),
  getCalendarService: vi.fn(),
  from: vi.fn(),
  tokenSelect: vi.fn(),
  tokenEq: vi.fn(),
  tokenSingle: vi.fn(),
  hoursSelect: vi.fn(),
  hoursEq: vi.fn(),
  hoursSingle: vi.fn(),
  offering: vi.fn(),
  freeBusyQuery: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking/settings.server", () => ({ getEffectiveBookingOffering: mocks.offering }));
vi.mock("./bookingOperational.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./bookingOperational.server")>();
  return {
    ...actual,
    assertBookingOperationallyAllowed: mocks.assertBookingOperationallyAllowed
  };
});
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
  canUseFeature: mocks.canUseFeature
}));
vi.mock("./client", () => ({
  getAuthenticatedClient: mocks.getAuthenticatedClient,
  getCalendarService: mocks.getCalendarService
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from }
}));

import { BookingOperationalBlockedError } from "./bookingOperational.server";
import { checkAvailability } from "./calendar";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const CALENDAR_ID = "connected-calendar";
const BUSINESS_TIMEZONE = "America/Indiana/Indianapolis";
const ORIGINAL_HOST_TIMEZONE = process.env.TZ;
const BUSINESS_HOURS = {
  id: "00000000-0000-4000-8000-000000000002",
  business_id: BUSINESS_ID,
  day_of_week: 1,
  open_time: "09:00:00",
  close_time: "10:00:00",
  is_closed: false
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  vi.stubEnv("CALENDAR_BOOKING_MAX_HORIZON_DAYS", "365");
  vi.resetAllMocks();

  const tokenQuery = {
    select: mocks.tokenSelect,
    eq: mocks.tokenEq,
    single: mocks.tokenSingle
  };
  mocks.tokenSelect.mockReturnValue(tokenQuery);
  mocks.tokenEq.mockReturnValue(tokenQuery);
  mocks.tokenSingle.mockResolvedValue({
    data: { calendar_id: CALENDAR_ID },
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
    data: BUSINESS_HOURS,
    error: null
  });

  mocks.from.mockImplementation((table: string) => {
    if (table === "google_calendar_tokens") return tokenQuery;
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
    freebusy: { query: mocks.freeBusyQuery }
  });
  mocks.freeBusyQuery.mockResolvedValue({
    data: { calendars: { [CALENDAR_ID]: { busy: [] } } }
  });
  mocks.assertBookingOperationallyAllowed.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (ORIGINAL_HOST_TIMEZONE === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_HOST_TIMEZONE;
  }
});

describe("availability business timezone handling", () => {
  it("queries the Indianapolis business window as absolute instants and excludes the matching busy slot", async () => {
    mocks.hoursSingle.mockResolvedValueOnce({
      data: {
        ...BUSINESS_HOURS,
        close_time: "10:30:00"
      },
      error: null
    });
    mocks.freeBusyQuery.mockResolvedValueOnce({
      data: {
        calendars: {
          [CALENDAR_ID]: {
            busy: [
              {
                start: "2026-08-03T13:30:00.000Z",
                end: "2026-08-03T14:00:00.000Z"
              }
            ]
          }
        }
      }
    });

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).resolves.toEqual(["9:00 AM", "10:00 AM"]);

    expect(mocks.freeBusyQuery).toHaveBeenCalledWith(
      {
        requestBody: {
          timeMin: "2026-08-03T13:00:00.000Z",
          timeMax: "2026-08-03T14:30:00.000Z",
          timeZone: BUSINESS_TIMEZONE,
          items: [{ id: CALENDAR_ID }]
        }
      },
      { retry: false, timeout: 10_000 }
    );
  });

  it.each([
    {
      date: "2026-03-08",
      openTime: "01:00:00",
      closeTime: "04:00:00",
      timeMin: "2026-03-08T06:00:00.000Z",
      timeMax: "2026-03-08T08:00:00.000Z",
      slots: ["1:00 AM", "1:30 AM", "3:00 AM", "3:30 AM"]
    },
    {
      date: "2026-11-01",
      openTime: "01:00:00",
      closeTime: "03:00:00",
      timeMin: "2026-11-01T05:00:00.000Z",
      timeMax: "2026-11-01T08:00:00.000Z",
      slots: ["1:00 AM", "1:30 AM", "2:00 AM", "2:30 AM"]
    }
  ])(
    "constructs $date transition-day windows and candidate starts deterministically",
    async ({ date, openTime, closeTime, timeMin, timeMax, slots }) => {
      mocks.hoursSingle.mockResolvedValueOnce({
        data: {
          ...BUSINESS_HOURS,
          day_of_week: 0,
          open_time: openTime,
          close_time: closeTime
        },
        error: null
      });

      await expect(
        checkAvailability(BUSINESS_ID, date, BUSINESS_TIMEZONE)
      ).resolves.toEqual(slots);

      expect(mocks.freeBusyQuery).toHaveBeenCalledWith(
        {
          requestBody: {
            timeMin,
            timeMax,
            timeZone: BUSINESS_TIMEZONE,
            items: [{ id: CALENDAR_ID }]
          }
        },
        { retry: false, timeout: 10_000 }
      );
    }
  );

  it("resolves today in the business timezone across the UTC midnight boundary and excludes elapsed slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T02:30:00.000Z"));
    mocks.hoursSingle.mockResolvedValueOnce({
      data: {
        ...BUSINESS_HOURS,
        day_of_week: 0
      },
      error: null
    });

    await expect(
      checkAvailability(BUSINESS_ID, "today", BUSINESS_TIMEZONE)
    ).resolves.toEqual([]);

    expect(mocks.hoursEq).toHaveBeenCalledWith("day_of_week", 0);
    expect(mocks.freeBusyQuery).toHaveBeenCalledWith(
      {
        requestBody: {
          timeMin: "2026-08-02T13:00:00.000Z",
          timeMax: "2026-08-02T14:00:00.000Z",
          timeZone: BUSINESS_TIMEZONE,
          items: [{ id: CALENDAR_ID }]
        }
      },
      { retry: false, timeout: 10_000 }
    );
  });

  it("rejects a past date before OAuth, token, hours, or Google work", async () => {
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-02", BUSINESS_TIMEZONE)
    ).rejects.toThrow("cannot be checked in the past");
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it("rejects a date beyond the default 90-day horizon before OAuth or Google work", async () => {
    vi.stubEnv("CALENDAR_BOOKING_MAX_HORIZON_DAYS", "");
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    await expect(
      checkAvailability(BUSINESS_ID, "2026-11-01", BUSINESS_TIMEZONE)
    ).rejects.toThrow("outside the booking horizon");
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it("filters same-day slots using the configured minimum lead time", async () => {
    vi.stubEnv("CALENDAR_BOOKING_MIN_LEAD_MINUTES", "60");
    vi.setSystemTime(new Date("2026-08-03T12:30:00.000Z"));

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).resolves.toEqual(["9:30 AM"]);
  });

  it("advertises only 30-minute-aligned starts when business hours open off-grid", async () => {
    mocks.hoursSingle.mockResolvedValueOnce({
      data: {
        ...BUSINESS_HOURS,
        open_time: "09:15:00",
        close_time: "10:15:00"
      },
      error: null
    });

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).resolves.toEqual(["9:30 AM"]);
  });

  it("fails closed before Google when configured hours have no forward range", async () => {
    mocks.hoursSingle.mockResolvedValueOnce({
      data: {
        ...BUSINESS_HOURS,
        open_time: "10:00:00",
        close_time: "09:00:00"
      },
      error: null
    });

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).rejects.toThrow("invalid time range");
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["CALENDAR_BOOKING_MIN_LEAD_MINUTES", "-1"],
    ["CALENDAR_BOOKING_MIN_LEAD_MINUTES", "1.5"],
    ["CALENDAR_BOOKING_MAX_HORIZON_DAYS", "not-a-number"],
    ["CALENDAR_BOOKING_MAX_HORIZON_DAYS", "366"]
  ])("fails closed for malformed %s=%s", async (name, value) => {
    vi.stubEnv(name, value);

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).rejects.toThrow(`Invalid ${name} calendar configuration.`);
    expect(mocks.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["missing calendar result", { data: { calendars: {} } }],
    [
      "calendar-level provider error",
      {
        data: {
          calendars: {
            [CALENDAR_ID]: { errors: [{ reason: "notFound" }] }
          }
        }
      }
    ],
    [
      "malformed busy period",
      {
        data: {
          calendars: {
            [CALENDAR_ID]: {
              busy: [{ start: "not-a-date", end: "also-not-a-date" }]
            }
          }
        }
      }
    ]
  ])("fails closed on %s", async (_label, response) => {
    mocks.freeBusyQuery.mockResolvedValueOnce(response);

    await expect(
      checkAvailability(BUSINESS_ID, "2026-08-03", BUSINESS_TIMEZONE)
    ).rejects.toThrow(/availability|invalid/i);
  });
});

describe("availability operational races", () => {
  it("rechecks before returning closed-hours availability", async () => {
    const hoursRead = deferred<{
      data: typeof BUSINESS_HOURS;
      error: null;
    }>();
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    let paused = false;
    mocks.hoursSingle.mockReturnValueOnce(hoursRead.promise);
    mocks.assertBookingOperationallyAllowed.mockImplementation(async () => {
      if (paused) throw blocked;
    });

    const availability = checkAvailability(BUSINESS_ID, "2026-08-03", "UTC");
    await vi.waitFor(() => {
      expect(mocks.hoursSingle).toHaveBeenCalledOnce();
    });

    paused = true;
    hoursRead.resolve({
      data: { ...BUSINESS_HOURS, is_closed: true },
      error: null
    });

    await expect(availability).rejects.toBe(blocked);
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(2);
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it("blocks a pause that lands after entry but before Google free/busy", async () => {
    const hoursRead = deferred<{
      data: typeof BUSINESS_HOURS;
      error: null;
    }>();
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "bookings_paused"
    );
    let paused = false;
    mocks.hoursSingle.mockReturnValueOnce(hoursRead.promise);
    mocks.assertBookingOperationallyAllowed.mockImplementation(async () => {
      if (paused) throw blocked;
    });

    const availability = checkAvailability(BUSINESS_ID, "2026-08-03", "UTC");
    await vi.waitFor(() => {
      expect(mocks.hoursSingle).toHaveBeenCalledOnce();
    });

    paused = true;
    hoursRead.resolve({ data: BUSINESS_HOURS, error: null });

    await expect(availability).rejects.toBe(blocked);
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(2);
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });

  it("blocks stale availability when a pause lands during Google free/busy", async () => {
    const providerRead = deferred<{
      data: { calendars: Record<string, { busy: never[] }> };
    }>();
    const blocked = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "account_suspended"
    );
    let paused = false;
    mocks.freeBusyQuery.mockReturnValueOnce(providerRead.promise);
    mocks.assertBookingOperationallyAllowed.mockImplementation(async () => {
      if (paused) throw blocked;
    });

    const availability = checkAvailability(BUSINESS_ID, "2026-08-03", "UTC");
    await vi.waitFor(() => {
      expect(mocks.freeBusyQuery).toHaveBeenCalledOnce();
    });

    paused = true;
    providerRead.resolve({
      data: { calendars: { [CALENDAR_ID]: { busy: [] } } }
    });

    await expect(availability).rejects.toBe(blocked);
    expect(mocks.assertBookingOperationallyAllowed).toHaveBeenCalledTimes(3);
    expect(mocks.freeBusyQuery).toHaveBeenCalledOnce();
  });
});


describe("configured appointment duration", () => {
  it("checks the whole 90 minute interval against Google busy time", async () => {
    mocks.offering.mockResolvedValue({ durationMinutes: 90 });
    mocks.hoursSingle.mockResolvedValue({ data: { ...BUSINESS_HOURS, close_time: "12:00:00" }, error: null });
    mocks.freeBusyQuery.mockResolvedValue({ data: { calendars: { [CALENDAR_ID]: { busy: [{ start: "2026-03-02T15:00:00Z", end: "2026-03-02T15:30:00Z" }] } } } });
    const original = mocks.from.getMockImplementation()!;
    const local: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve) };
    for (const method of ['select','eq','in','lt','gt']) local[method] = () => local;
    mocks.from.mockImplementation((table: string) => table === 'calendar_bookings' ? local : original(table));
    expect(await checkAvailability(BUSINESS_ID, "2026-03-02", BUSINESS_TIMEZONE, undefined, "service")).toEqual(["10:30 AM"]);
  });
  it("does not advertise a slot blocked by a local pending reservation", async () => {
    mocks.offering.mockResolvedValue({ durationMinutes: 60 });
    const original = mocks.from.getMockImplementation()!;
    const local: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ starts_at: '2026-03-02T14:30:00Z', ends_at: '2026-03-02T15:00:00Z' }], error: null }).then(resolve) };
    for (const method of ['select','eq','in','lt','gt']) local[method] = () => local;
    mocks.from.mockImplementation((table: string) => table === 'calendar_bookings' ? local : original(table));
    expect(await checkAvailability(BUSINESS_ID, "2026-03-02", BUSINESS_TIMEZONE, undefined, "service")).toEqual([]);
  });
  it("requires service identity when new confirmations are enabled", async () => {
    vi.stubEnv('BOOKING_CONFIRMATION_V2_ENABLED', 'true');
    await expect(checkAvailability(BUSINESS_ID, "2026-03-02", BUSINESS_TIMEZONE)).rejects.toThrow('Choose a service');
    expect(mocks.freeBusyQuery).not.toHaveBeenCalled();
  });
});
