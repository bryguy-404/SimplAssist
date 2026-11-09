import { describe, expect, it } from "vitest";
import type { AISettings } from "@/types/database";
import {
  bookingRequestTools,
  calendarTools,
  CREATE_BOOKING_START_TIME_CONTRACT,
  shouldIncludeBookingRequestTools,
  shouldIncludeCalendarTools,
  signupGoalTools
} from "./tools";

const directSettings = {
  booking_enabled: true,
  booking_mode: "schedule_direct"
} as AISettings;

const collectSettings = {
  booking_enabled: true,
  booking_mode: "collect_info"
} as AISettings;

describe("shouldIncludeCalendarTools", () => {
  it("enables direct booking only for connected schedule_direct mode", () => {
    expect(shouldIncludeCalendarTools(directSettings, true)).toBe(true);
  });

  it("removes direct-booking tools while booking is operationally unavailable", () => {
    expect(shouldIncludeCalendarTools(directSettings, true, false)).toBe(false);
  });

  it.each([
    [{ ...directSettings, booking_enabled: false }, true],
    [{ ...directSettings, booking_mode: "collect_info" }, true],
    [directSettings, false]
  ])("excludes non-direct booking configuration %#", (settings, connected) => {
    expect(shouldIncludeCalendarTools(settings as AISettings, connected)).toBe(
      false
    );
  });
});

describe("calendarTools strict input contract", () => {
  it("requires bounded date input with no extra properties", () => {
    const availabilityTool = calendarTools.find(
      (tool) => tool.name === "check_availability"
    );
    expect(availabilityTool?.input_schema).toMatchObject({
      additionalProperties: false,
      properties: {
        date: {
          minLength: 10,
          maxLength: 10,
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        }
      }
    });
  });

  it("requires the exact business-local no-offset start_time format", () => {
    const createBookingTool = calendarTools.find(
      (tool) => tool.name === "create_booking"
    );
    const inputSchema = createBookingTool?.input_schema as
      | {
          additionalProperties?: boolean;
          properties?: {
            start_time?: {
              description?: string;
              minLength?: number;
              maxLength?: number;
              pattern?: string;
            };
          };
        }
      | undefined;

    expect(CREATE_BOOKING_START_TIME_CONTRACT).toBe(
      "create_booking.start_time must be a business-local wall time in exactly YYYY-MM-DDTHH:mm:ss format with NO Z suffix or UTC offset."
    );
    expect(inputSchema?.properties?.start_time?.description).toBe(
      CREATE_BOOKING_START_TIME_CONTRACT
    );
    expect(inputSchema?.additionalProperties).toBe(false);
    expect(inputSchema?.properties?.start_time).toMatchObject({
      minLength: 19,
      maxLength: 19,
      pattern: "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:00$"
    });
  });

  it("bounds identity, contact, catalog, and duration fields", () => {
    const createBookingTool = calendarTools.find(
      (tool) => tool.name === "create_booking"
    );
    expect(createBookingTool?.input_schema).toMatchObject({
      additionalProperties: false,
      properties: {
        customer_name: { minLength: 1, maxLength: 200 },
        customer_phone: { minLength: 1, maxLength: 50 },
        customer_email: {
          minLength: 3,
          maxLength: 254,
          format: "email"
        },
        service_name: { minLength: 1, maxLength: 200 },
        duration_minutes: {
          type: "integer",
          enum: [30, 60, 90, 120, 150, 180, 210, 240]
        }
      }
    });
  });
});

describe("shouldIncludeBookingRequestTools", () => {
  it.each([
    [true, collectSettings, true],
    [false, collectSettings, false],
    [false, { ...collectSettings, booking_enabled: false }, true],
    [false, directSettings, true],
    [false, { ...directSettings, booking_enabled: false }, true]
  ])(
    "returns %s for booking configuration %#",
    (expected, settings, operationallyAvailable) => {
      expect(
        shouldIncludeBookingRequestTools(
          settings as AISettings,
          operationallyAvailable
        )
      ).toBe(expected);
    }
  );

  it("defaults the operational availability fence to enabled", () => {
    expect(shouldIncludeBookingRequestTools(collectSettings)).toBe(true);
  });
});

describe("bookingRequestTools", () => {
  it("exposes only the request-recording tool with required service and verbatim requested time", () => {
    expect(bookingRequestTools).toEqual([
      {
        name: "record_booking_request",
        description:
          "Record a customer's appointment request for the business owner to review. This records a request only; it does not create, book, or confirm an appointment. Use it after gathering the service, the customer's own requested-time words, and any available customer identity.",
        input_schema: {
          type: "object",
          properties: {
            requested_service: {
              type: "string",
              description:
                'The requested service in the customer\'s own words. If a usable service is still missing after one ask, use exactly "not specified".'
            },
            requested_time_text: {
              type: "string",
              description:
                "The customer's requested time in the customer's own words. Copy those words verbatim; do not parse, normalize, infer, or reformat them as a date or time. If a usable time is still missing after one ask, use exactly \"not specified\"."
            },
            customer_name: {
              type: "string",
              description: "The customer-provided name, if available"
            },
            customer_phone: {
              type: "string",
              description: "The customer-provided phone number, if available"
            },
            customer_email: {
              type: "string",
              description: "The customer-provided email address, if available"
            }
          },
          required: ["requested_service", "requested_time_text"]
        }
      }
    ]);
  });
});

describe("signupGoalTools", () => {
  it("exposes only the no-input goal-link offer tool", () => {
    expect(signupGoalTools).toEqual([
      {
        name: "offer_goal_link",
        description:
          "Offer the business's website link when the customer's current inbound message shows interest in taking the next step on its website, such as requesting a quote, requesting a booking, or signing up. Use this only for the direct reply to that inbound message. The tool returns the exact URL to include in that reply.",
        input_schema: {
          type: "object",
          properties: {},
          required: []
        }
      }
    ]);
  });
});
