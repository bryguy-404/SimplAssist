import type { AISettings } from "@/types/database";
import type Anthropic from "@anthropic-ai/sdk";

export const CREATE_BOOKING_START_TIME_CONTRACT =
  "create_booking.start_time must be a business-local wall time in exactly YYYY-MM-DDTHH:mm:ss format with NO Z suffix or UTC offset.";

export const signupGoalTools: Anthropic.Tool[] = [
  {
    name: "offer_goal_link",
    description:
      "Offer the business's website link when the customer's current inbound message shows interest in taking the next step on its website, such as requesting a quote, requesting a booking, or signing up. Use this only for the direct reply to that inbound message. The tool returns the exact URL to include in that reply.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: []
    }
  }
];

export const bookingRequestTools: Anthropic.Tool[] = [
  {
    name: "record_booking_request",
    description:
      "Record a customer's appointment request for the business owner to review. This records a request only; it does not create, book, or confirm an appointment. Use it after gathering the service, the customer's own requested-time words, and any available customer identity.",
    input_schema: {
      type: "object" as const,
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
];

export const calendarTools: Anthropic.Tool[] = [
  {
    name: "check_availability",
    description:
      "Check available appointment slots on the business calendar for a specific date. Use this when a customer wants to book an appointment and you need to show them available times.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        date: {
          type: "string",
          minLength: 10,
          maxLength: 10,
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "The date to check availability for, in YYYY-MM-DD format"
        }
      },
      required: ["date"]
    }
  },
  {
    name: "create_booking",
    description:
      "Create a confirmed appointment on the business calendar. Use this only after the customer has confirmed a specific time slot, and you have collected their name and the service they want.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        customer_name: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "The customer's full name"
        },
        customer_phone: {
          type: "string",
          minLength: 1,
          maxLength: 50,
          description: "The customer's phone number"
        },
        customer_email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          format: "email",
          description:
            "The customer's email (optional). Include it only after it has been saved and confirmed for this contact; invitations are never sent to an unverified tool-supplied address."
        },
        service_name: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "The exact name of one active service from the business service catalog. Never invent or paraphrase a service name."
        },
        start_time: {
          type: "string",
          minLength: 19,
          maxLength: 19,
          pattern: "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:00$",
          description: CREATE_BOOKING_START_TIME_CONTRACT
        },
        duration_minutes: {
          type: "integer",
          enum: [30, 60, 90, 120, 150, 180, 210, 240],
          description:
            "Duration in minutes, default 30; must be a 30-minute increment and no more than 240 minutes"
        }
      },
      required: ["customer_name", "service_name", "start_time"]
    }
  }
];

export function shouldIncludeCalendarTools(
  aiSettings: AISettings,
  hasCalendarConnected: boolean,
  bookingOperationallyAvailable: boolean = true
): boolean {
  return (
    bookingOperationallyAvailable &&
    aiSettings.booking_enabled &&
    aiSettings.booking_mode === "schedule_direct" &&
    hasCalendarConnected
  );
}

export function shouldIncludeBookingRequestTools(
  aiSettings: AISettings,
  bookingOperationallyAvailable: boolean = true
): boolean {
  return (
    bookingOperationallyAvailable &&
    aiSettings.booking_enabled &&
    aiSettings.booking_mode === "collect_info"
  );
}
