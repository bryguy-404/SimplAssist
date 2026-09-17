import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedClient, getCalendarService } from "@/lib/google/client";
import { requireAuthenticatedFeature } from "@/lib/google/routeAccess";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import {
  assertBookingOperationallyAllowed,
  isBookingOperationalBlockedError,
  isBookingOperationalStateError,
} from "@/lib/google/bookingOperational.server";
import { isOperationalControlsResolutionError } from "@/lib/account/operationalControls.server";
import { buildDashboardBookingSourceKey } from "@/lib/metrics/sourceKeys.server";
import { recordBusinessMetricEventBestEffort } from "@/lib/metrics/recording.server";
import {
  CALENDAR_OPERATION_PRIVATE_KEY,
  CalendarProviderOperationBusyError,
  CalendarProviderOperationConflictError,
  CalendarProviderOperationStateError,
  CalendarProviderSlotUnavailableError,
  acquireCalendarProviderOperation,
  buildCalendarProviderEvidence,
  createDeterministicGoogleEventId,
  failCalendarProviderOperation,
  finalizeCalendarProviderOperation,
  hasCalendarProviderOperationMarker,
  isDefinitiveCalendarProviderFailure,
  markCalendarProviderSubmissionStarted,
  markCalendarProviderOperationApplied,
  markCalendarProviderDeleteApplied,
  readCalendarProviderOperation,
  resolveCalendarProviderOperationAbsent,
  type AcquiredCalendarProviderOperation,
  type CalendarProviderOperation,
} from "@/lib/google/calendarProviderOperations.server";
import type { calendar_v3 } from "googleapis";

type LinkedCalendarBooking = {
  id: string;
  google_calendar_id: string;
  starts_at: string;
  ends_at: string;
};

const CALENDAR_PROVIDER_TIMEOUT_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isGoogleEventNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  return (
    candidate.code === 404 ||
    candidate.code === "404" ||
    candidate.code === 410 ||
    candidate.code === "410" ||
    candidate.response?.status === 404 ||
    candidate.response?.status === 410
  );
}

async function findLinkedCalendarBooking(
  businessId: string,
  googleEventId: string,
  selectedCalendarId: string
): Promise<LinkedCalendarBooking | null> {
  const { data, error } = await supabaseAdmin
    .from("calendar_bookings")
    .select("id,google_calendar_id,starts_at,ends_at")
    .eq("business_id", businessId)
    .eq("google_event_id", googleEventId)
    .limit(2);

  if (error) {
    throw new Error(
      `Could not resolve linked booking ${googleEventId}: ${error.message}`
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `Linked booking ${googleEventId} returned invalid query data.`
    );
  }
  if (data.length === 0) return null;
  const candidate =
    data.length === 1
      ? data[0]
      : data.find(
          (booking) =>
            booking?.google_calendar_id === selectedCalendarId
        );
  if (!candidate) {
    throw new Error(
      `Linked booking ${googleEventId} is ambiguous across calendars.`
    );
  }
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    typeof candidate.google_calendar_id !== "string" ||
    !candidate.google_calendar_id.trim() ||
    typeof candidate.starts_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.starts_at)) ||
    typeof candidate.ends_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.ends_at))
  ) {
    throw new Error(
      `Linked booking ${googleEventId} returned invalid calendar data.`
    );
  }
  return candidate as LinkedCalendarBooking;
}

export async function GET(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;

  const { searchParams } = request.nextUrl;
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end query params required" },
      { status: 400 }
    );
  }

  const access = await requireAuthenticatedFeature("calendar");
  if (!access.ok) return access.response;
  if (access.businessId !== workspace.access.business.id) {
    return workspaceChangedResponse();
  }

  const { data: token, error: tokenError } = await access.supabase
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", access.businessId)
    .maybeSingle();

  if (tokenError) {
    console.error("[calendar/events] Token lookup failed", {
      code: tokenError.code ?? null,
    });
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  if (!token) {
    return NextResponse.json({ connected: false });
  }

  try {
    const client = await getAuthenticatedClient(access.businessId);
    if (!client) {
      return NextResponse.json({ connected: false });
    }

    const calendar = getCalendarService(client);
    const calendarId = token.calendar_id || "primary";

    const response = await calendar.events.list(
      {
        calendarId,
        timeMin: start,
        timeMax: end,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      },
      { timeout: CALENDAR_PROVIDER_TIMEOUT_MS, retry: false }
    );

    const events = (response.data.items ?? []).map((event) => {
      const allDay = !!event.start?.date;
      return {
        id: event.id ?? "",
        title: event.summary ?? "(No title)",
        start: event.start?.dateTime ?? event.start?.date ?? "",
        end: event.end?.dateTime ?? event.end?.date ?? "",
        allDay,
        description: event.description ?? null,
        location: event.location ?? null,
      };
    });

    return NextResponse.json({ events });
  } catch (err) {
    logSanitizedCalendarFailure("read", err);
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  if (workspace.access.business.primary_goal === "signup") {
    return calendarGoalUnavailableResponse();
  }

  let body: {
    operationId?: string;
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { operationId, title, description, startTime, endTime } = body;

  if (
    !operationId ||
    !UUID_PATTERN.test(operationId) ||
    !title ||
    !startTime ||
    !endTime ||
    !isFiniteTimestamp(startTime) ||
    !isFiniteTimestamp(endTime)
  ) {
    return NextResponse.json(
      {
        error:
          "operationId, title, startTime, and endTime are required",
      },
      { status: 400 }
    );
  }

  if (new Date(endTime) <= new Date(startTime)) {
    return NextResponse.json(
      { error: "endTime must be after startTime" },
      { status: 400 }
    );
  }

  const access = await requireAuthenticatedFeature("calendar");
  if (!access.ok) return access.response;
  if (access.businessId !== workspace.access.business.id) {
    return workspaceChangedResponse();
  }

  let recoveryEligible = false;
  let existingOperation: CalendarProviderOperation | null = null;
  try {
    existingOperation = await readCalendarProviderOperation(
      access.businessId,
      operationId
    );
    recoveryEligible = Boolean(
      existingOperation &&
        existingOperation.operation_kind === "create" &&
        ["holding", "provider_applied", "finalized"].includes(
          existingOperation.status
        )
    );
  } catch (error) {
    return (
      calendarOperationErrorResponse(error) ??
      NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      )
    );
  }

  if (
    existingOperation &&
    existingOperation.operation_kind !== "create" &&
    ["holding", "provider_applied", "finalized"].includes(
      existingOperation.status
    )
  ) {
    return calendarOperationErrorResponse(
      new CalendarProviderOperationConflictError()
    )!;
  }

  if (!recoveryEligible) {
    const entryOperationalResponse = await bookingCreationOperationalResponse(
      access.businessId
    );
    if (entryOperationalResponse) return entryOperationalResponse;
  }

  if (
    existingOperation &&
    ["provider_applied", "finalized"].includes(existingOperation.status)
  ) {
    try {
      const deterministicEventId =
        existingOperation.deterministic_google_event_id ??
        createDeterministicGoogleEventId(operationId);
      const acquired = await acquireCalendarProviderOperation({
        operationId,
        businessId: access.businessId,
        kind: "create",
        calendarId: existingOperation.google_calendar_id,
        startsAt: existingOperation.desired_starts_at,
        endsAt: existingOperation.desired_ends_at,
        linkedBookingId: null,
        deterministicGoogleEventId: deterministicEventId,
        targetGoogleEventId: null,
        requestPayload: {
          title,
          titleProvided: true,
          description: description || null,
          descriptionProvided: description !== undefined,
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          eventId: null,
        },
      });
      const finalized =
        acquired.operation.status === "provider_applied"
          ? await finalizeCalendarProviderOperation(
              access.businessId,
              operationId
            )
          : acquired.operation;
      const completed = finalizedOperationResponse(finalized, {
        id: deterministicEventId,
        title,
        start: startTime,
        end: endTime,
      });
      recordDashboardBookingMetric(
        access.businessId,
        existingOperation.google_calendar_id,
        completed.id
      );
      return NextResponse.json({ event: completed });
    } catch (error) {
      return (
        calendarOperationErrorResponse(error) ??
        NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        )
      );
    }
  }

  const { data: token, error: tokenError } = await access.supabase
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", access.businessId)
    .maybeSingle();

  if (tokenError) {
    console.error("[calendar/events] Token lookup failed", {
      code: tokenError.code ?? null,
    });
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  if (!token) {
    return NextResponse.json(
      { error: "Google Calendar not connected" },
      { status: 400 }
    );
  }

  const preflightNamespace = calendarProviderNamespace(token);
  if (!preflightNamespace) {
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }
  try {
    const preflightClient = await getAuthenticatedClient(access.businessId);
    if (!preflightClient) {
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }
  } catch (error) {
    logSanitizedCalendarFailure("create", error);
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  const calendarId =
    recoveryEligible && existingOperation
      ? existingOperation.google_calendar_id
      : token.calendar_id || "primary";
  const deterministicEventId =
    recoveryEligible && existingOperation?.deterministic_google_event_id
      ? existingOperation.deterministic_google_event_id
      : createDeterministicGoogleEventId(operationId);
  const operationStartsAt =
    recoveryEligible && existingOperation?.desired_starts_at
      ? existingOperation.desired_starts_at
      : startTime;
  const operationEndsAt =
    recoveryEligible && existingOperation?.desired_ends_at
      ? existingOperation.desired_ends_at
      : endTime;

  let acquired: AcquiredCalendarProviderOperation;
  try {
    // Own the durable business/slot/target boundary before constructing the
    // mutation client. The discarded credential preflight preserves existing
    // invalid-token behavior; the post-acquire reload closes OAuth swaps.
    acquired = await acquireCalendarProviderOperation({
      operationId,
      businessId: access.businessId,
      kind: "create",
      calendarId,
      startsAt: operationStartsAt,
      endsAt: operationEndsAt,
      linkedBookingId: null,
      deterministicGoogleEventId: deterministicEventId,
      targetGoogleEventId: null,
      requestPayload: {
        title,
        titleProvided: true,
        description: description || null,
        descriptionProvided: description !== undefined,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        eventId: null,
      },
    });
  } catch (error) {
    return (
      calendarOperationErrorResponse(error) ??
      NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      )
    );
  }

  try {
    const { data: currentToken, error: currentTokenError } =
      await access.supabase
        .from("google_calendar_tokens")
        .select("calendar_id, google_email")
        .eq("business_id", access.businessId)
        .maybeSingle();
    if (
      currentTokenError ||
      !currentToken ||
      calendarProviderNamespace(currentToken) !== preflightNamespace
    ) {
      await failCalendarProviderOperationBeforeSubmission(
        acquired,
        "Provider namespace changed before submission."
      );
      return NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      );
    }

    let client: Awaited<ReturnType<typeof getAuthenticatedClient>>;
    try {
      client = await getAuthenticatedClient(access.businessId);
    } catch (cause) {
      return await handleProviderReadFailure(acquired, cause);
    }
    if (!client) {
      const failedBeforeSubmission =
        await failCalendarProviderOperationBeforeSubmission(
          acquired,
          "Provider credentials were unavailable before submission."
        );
      if (!failedBeforeSubmission) {
        return NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }

    const calendar = getCalendarService(client);

    const completed = await completeCreateOperation({
      calendar,
      calendarId,
      businessId: access.businessId,
      acquired,
      operationId,
      deterministicEventId,
      title,
      description,
      startTime,
      endTime,
    });

    recordDashboardBookingMetric(
      access.businessId,
      calendarId,
      completed.id
    );
    return NextResponse.json({ event: completed });
  } catch (err) {
    const operationResponse = calendarOperationErrorResponse(err);
    if (operationResponse) return operationResponse;
    logSanitizedCalendarFailure("create", err);
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  if (workspace.access.business.primary_goal === "signup") {
    return calendarGoalUnavailableResponse();
  }

  let body: {
    operationId?: string;
    eventId?: string;
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { operationId, eventId, title, description, startTime, endTime } = body;

  if (!operationId || !UUID_PATTERN.test(operationId) || !eventId) {
    return NextResponse.json(
      { error: "operationId and eventId are required" },
      { status: 400 }
    );
  }

  if (
    (startTime && !isFiniteTimestamp(startTime)) ||
    (endTime && !isFiniteTimestamp(endTime)) ||
    (startTime && endTime && new Date(endTime) <= new Date(startTime))
  ) {
    return NextResponse.json(
      { error: "endTime must be after startTime" },
      { status: 400 }
    );
  }

  const access = await requireAuthenticatedFeature("calendar");
  if (!access.ok) return access.response;
  if (access.businessId !== workspace.access.business.id) {
    return workspaceChangedResponse();
  }

  let durableOperation: CalendarProviderOperation | null;
  try {
    durableOperation = await readCalendarProviderOperation(
      access.businessId,
      operationId
    );
  } catch (error) {
    return (
      calendarOperationErrorResponse(error) ??
      NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      )
    );
  }
  const durableRecovery = Boolean(
    durableOperation &&
      durableOperation.operation_kind === "update" &&
      ["holding", "provider_applied", "finalized"].includes(
        durableOperation.status
      )
  );
  if (
    durableOperation &&
    durableOperation.operation_kind !== "update" &&
    ["holding", "provider_applied", "finalized"].includes(
      durableOperation.status
    )
  ) {
    return calendarOperationErrorResponse(
      new CalendarProviderOperationConflictError()
    )!;
  }

  if (
    durableOperation &&
    ["provider_applied", "finalized"].includes(durableOperation.status)
  ) {
    try {
      const acquired = await acquireCalendarProviderOperation({
        operationId,
        businessId: access.businessId,
        kind: "update",
        calendarId: durableOperation.google_calendar_id,
        startsAt: durableOperation.desired_starts_at,
        endsAt: durableOperation.desired_ends_at,
        linkedBookingId: durableOperation.linked_booking_id,
        deterministicGoogleEventId: null,
        targetGoogleEventId: durableOperation.target_google_event_id,
        requestPayload: {
          title: title ?? null,
          titleProvided: title !== undefined,
          description: description ?? null,
          descriptionProvided: description !== undefined,
          startTime: startTime
            ? new Date(startTime).toISOString()
            : null,
          endTime: endTime ? new Date(endTime).toISOString() : null,
          eventId,
        },
      });
      const finalized =
        acquired.operation.status === "provider_applied"
          ? await finalizeCalendarProviderOperation(
              access.businessId,
              operationId
            )
          : acquired.operation;
      return NextResponse.json({
        event: finalizedOperationResponse(finalized, {
          id: durableOperation.target_google_event_id ?? eventId,
          title: title ?? "",
          start:
            durableOperation.desired_starts_at ?? startTime ?? "",
          end: durableOperation.desired_ends_at ?? endTime ?? "",
          description: description ?? null,
        }),
      });
    } catch (error) {
      return (
        calendarOperationErrorResponse(error) ??
        NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        )
      );
    }
  }

  const { data: token, error: tokenError } = await access.supabase
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", access.businessId)
    .maybeSingle();

  if (tokenError) {
    console.error("[calendar/events] Token lookup failed", {
      code: tokenError.code ?? null,
    });
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  if (!token) {
    return NextResponse.json(
      { error: "Google Calendar not connected" },
      { status: 400 }
    );
  }
  const preflightNamespace = calendarProviderNamespace(token);
  if (!preflightNamespace) {
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  try {
    const client = await getAuthenticatedClient(access.businessId);
    if (!client) {
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }

    const calendar = getCalendarService(client);
    const selectedCalendarId = token.calendar_id || "primary";
    const effectiveEventId =
      durableRecovery && durableOperation?.target_google_event_id
        ? durableOperation.target_google_event_id
        : eventId;
    const linkedBooking = durableRecovery
      ? null
      : await findLinkedCalendarBooking(
          access.businessId,
          eventId,
          selectedCalendarId
        );
    const calendarId =
      durableRecovery && durableOperation
        ? durableOperation.google_calendar_id
        : linkedBooking?.google_calendar_id || selectedCalendarId;
    const linkedBookingId =
      durableRecovery && durableOperation
        ? durableOperation.linked_booking_id
        : linkedBooking?.id ?? null;

    // Fully timestamped dashboard requests acquire their database hold before
    // any provider read. Legacy title/description-only and one-sided time
    // updates derive the missing half-open boundary from a linked durable row
    // or, for generic Google-only events, one read-only provider GET.
    let existingEvent: calendar_v3.Schema$Event | null = null;
    let desiredStart =
      (durableRecovery ? durableOperation?.desired_starts_at : null) ||
      startTime ||
      linkedBooking?.starts_at;
    let desiredEnd =
      (durableRecovery ? durableOperation?.desired_ends_at : null) ||
      endTime ||
      linkedBooking?.ends_at;
    if (!desiredStart || !desiredEnd) {
      existingEvent = await findCalendarEvent(
        calendar,
        calendarId,
        effectiveEventId
      );
      if (!existingEvent) {
        return NextResponse.json(
          { error: "calendar_time_unavailable", retryable: false },
          { status: 409 }
        );
      }
      desiredStart = desiredStart ?? calendarEventStart(existingEvent) ?? undefined;
      desiredEnd = desiredEnd ?? calendarEventEnd(existingEvent) ?? undefined;
    }
    if (
      !desiredStart ||
      !desiredEnd ||
      !isFiniteTimestamp(desiredStart) ||
      !isFiniteTimestamp(desiredEnd) ||
      new Date(desiredEnd) <= new Date(desiredStart)
    ) {
      return NextResponse.json(
        { error: "endTime must be after startTime" },
        { status: 400 }
      );
    }

    const acquired = await acquireCalendarProviderOperation({
      operationId,
      businessId: access.businessId,
      kind: "update",
      calendarId,
      startsAt: desiredStart,
      endsAt: desiredEnd,
      linkedBookingId,
      deterministicGoogleEventId: null,
      targetGoogleEventId: effectiveEventId,
      requestPayload: {
        title: title ?? null,
        titleProvided: title !== undefined,
        description: description ?? null,
        descriptionProvided: description !== undefined,
        startTime: startTime
          ? new Date(startTime).toISOString()
          : null,
        endTime: endTime ? new Date(endTime).toISOString() : null,
        eventId,
      },
    });

    const { data: currentToken, error: currentTokenError } =
      await access.supabase
        .from("google_calendar_tokens")
        .select("calendar_id, google_email")
        .eq("business_id", access.businessId)
        .maybeSingle();
    if (
      currentTokenError ||
      !currentToken ||
      calendarProviderNamespace(currentToken) !== preflightNamespace
    ) {
      await failCalendarProviderOperationBeforeSubmission(
        acquired,
        "Provider namespace changed before submission."
      );
      return NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      );
    }
    let mutationClient: Awaited<ReturnType<typeof getAuthenticatedClient>>;
    try {
      mutationClient = await getAuthenticatedClient(access.businessId);
    } catch (cause) {
      return await handleProviderReadFailure(acquired, cause);
    }
    if (!mutationClient) {
      const failedBeforeSubmission =
        await failCalendarProviderOperationBeforeSubmission(
          acquired,
          "Provider credentials were unavailable before submission."
        );
      if (!failedBeforeSubmission) {
        return NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }
    const mutationCalendar = getCalendarService(mutationClient);

    // Build only the fields that were provided
    const requestBody: Record<string, unknown> = {};
    if (title !== undefined) requestBody.summary = title;
    if (description !== undefined) requestBody.description = description;
    if (startTime) requestBody.start = { dateTime: startTime };
    if (endTime) requestBody.end = { dateTime: endTime };

    const completed = await completeUpdateOperation({
      calendar: mutationCalendar,
      calendarId,
      businessId: access.businessId,
      acquired,
      operationId,
      eventId: effectiveEventId,
      requestBody,
      // Any pre-acquire read belongs only to interval derivation. Re-read the
      // held provider namespace before preserving etag/private properties.
      existingEvent: null,
      desiredStart,
      desiredEnd,
    });

    return NextResponse.json({ event: completed });
  } catch (err) {
    const operationResponse = calendarOperationErrorResponse(err);
    if (operationResponse) return operationResponse;
    logSanitizedCalendarFailure("update", err);
    return NextResponse.json(
      { error: "Failed to update event" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  if (workspace.access.business.primary_goal === "signup") {
    return calendarGoalUnavailableResponse();
  }

  const { searchParams } = request.nextUrl;
  const eventId = searchParams.get("eventId");
  const operationId = searchParams.get("operationId");

  if (!eventId || !operationId || !UUID_PATTERN.test(operationId)) {
    return NextResponse.json(
      { error: "eventId and operationId query params required" },
      { status: 400 }
    );
  }

  const access = await requireAuthenticatedFeature("calendar");
  if (!access.ok) return access.response;
  if (access.businessId !== workspace.access.business.id) {
    return workspaceChangedResponse();
  }

  let durableOperation: CalendarProviderOperation | null;
  try {
    durableOperation = await readCalendarProviderOperation(
      access.businessId,
      operationId
    );
  } catch (error) {
    return (
      calendarOperationErrorResponse(error) ??
      NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      )
    );
  }
  const durableRecovery = Boolean(
    durableOperation &&
      durableOperation.operation_kind === "delete" &&
      ["holding", "provider_applied", "finalized"].includes(
        durableOperation.status
      )
  );
  if (
    durableOperation &&
    durableOperation.operation_kind !== "delete" &&
    ["holding", "provider_applied", "finalized"].includes(
      durableOperation.status
    )
  ) {
    return calendarOperationErrorResponse(
      new CalendarProviderOperationConflictError()
    )!;
  }

  if (
    durableOperation &&
    durableOperation.operation_kind === "delete" &&
    ["provider_applied", "finalized"].includes(durableOperation.status)
  ) {
    try {
      const acquired = await acquireCalendarProviderOperation({
        operationId,
        businessId: access.businessId,
        kind: "delete",
        calendarId: durableOperation.google_calendar_id,
        startsAt: null,
        endsAt: null,
        linkedBookingId: durableOperation.linked_booking_id,
        deterministicGoogleEventId: null,
        targetGoogleEventId: durableOperation.target_google_event_id,
        requestPayload: {
          title: null,
          titleProvided: false,
          description: null,
          descriptionProvided: false,
          startTime: null,
          endTime: null,
          eventId,
        },
      });
      if (acquired.operation.status === "provider_applied") {
        await finalizeCalendarProviderOperation(
          access.businessId,
          operationId
        );
      }
      return NextResponse.json({ success: true });
    } catch (error) {
      return (
        calendarOperationErrorResponse(error) ??
        NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        )
      );
    }
  }

  const { data: token, error: tokenError } = await access.supabase
    .from("google_calendar_tokens")
    .select("calendar_id, google_email")
    .eq("business_id", access.businessId)
    .maybeSingle();

  if (tokenError) {
    console.error("[calendar/events] Token lookup failed", {
      code: tokenError.code ?? null,
    });
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  if (!token) {
    return NextResponse.json(
      { error: "Google Calendar not connected" },
      { status: 400 }
    );
  }
  const preflightNamespace = calendarProviderNamespace(token);
  if (!preflightNamespace) {
    return NextResponse.json(
      { error: "service_unavailable", retryable: true },
      { status: 503 }
    );
  }

  try {
    const client = await getAuthenticatedClient(access.businessId);
    if (!client) {
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }

    const selectedCalendarId = token.calendar_id || "primary";
    const effectiveEventId =
      durableRecovery && durableOperation?.target_google_event_id
        ? durableOperation.target_google_event_id
        : eventId;
    const linkedBooking = durableRecovery
      ? null
      : await findLinkedCalendarBooking(
          access.businessId,
          eventId,
          selectedCalendarId
        );
    const calendarId =
      durableRecovery && durableOperation
        ? durableOperation.google_calendar_id
        : linkedBooking?.google_calendar_id || selectedCalendarId;
    const linkedBookingId =
      durableRecovery && durableOperation
        ? durableOperation.linked_booking_id
        : linkedBooking?.id ?? null;

    const acquired = await acquireCalendarProviderOperation({
      operationId,
      businessId: access.businessId,
      kind: "delete",
      calendarId,
      startsAt: null,
      endsAt: null,
      linkedBookingId,
      deterministicGoogleEventId: null,
      targetGoogleEventId: effectiveEventId,
      requestPayload: {
        title: null,
        titleProvided: false,
        description: null,
        descriptionProvided: false,
        startTime: null,
        endTime: null,
        eventId,
      },
    });

    const { data: currentToken, error: currentTokenError } =
      await access.supabase
        .from("google_calendar_tokens")
        .select("calendar_id, google_email")
        .eq("business_id", access.businessId)
        .maybeSingle();
    if (
      currentTokenError ||
      !currentToken ||
      calendarProviderNamespace(currentToken) !== preflightNamespace
    ) {
      await failCalendarProviderOperationBeforeSubmission(
        acquired,
        "Provider namespace changed before submission."
      );
      return NextResponse.json(
        { error: "calendar_operation_unavailable", retryable: true },
        { status: 503 }
      );
    }
    let mutationClient: Awaited<ReturnType<typeof getAuthenticatedClient>>;
    try {
      mutationClient = await getAuthenticatedClient(access.businessId);
    } catch (cause) {
      return await handleProviderReadFailure(acquired, cause);
    }
    if (!mutationClient) {
      const failedBeforeSubmission =
        await failCalendarProviderOperationBeforeSubmission(
          acquired,
          "Provider credentials were unavailable before submission."
        );
      if (!failedBeforeSubmission) {
        return NextResponse.json(
          { error: "calendar_operation_unavailable", retryable: true },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Google Calendar not connected" },
        { status: 400 }
      );
    }
    const mutationCalendar = getCalendarService(mutationClient);

    await completeDeleteOperation({
      calendar: mutationCalendar,
      calendarId,
      businessId: access.businessId,
      operationId,
      eventId: effectiveEventId,
      acquired,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const operationResponse = calendarOperationErrorResponse(err);
    if (operationResponse) return operationResponse;
    logSanitizedCalendarFailure("delete", err);
    return NextResponse.json(
      { error: "Failed to delete event" },
      { status: 500 }
    );
  }
}

type CalendarService = ReturnType<typeof getCalendarService>;

type CalendarEventResponse = {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string | null;
};

async function completeDeleteOperation(input: {
  calendar: CalendarService;
  calendarId: string;
  businessId: string;
  operationId: string;
  eventId: string;
  acquired: AcquiredCalendarProviderOperation;
}): Promise<void> {
  if (input.acquired.operation.status === "finalized") return;

  if (input.acquired.operation.status === "provider_applied") {
    await finalizeCalendarProviderOperation(
      input.businessId,
      input.operationId
    );
    return;
  }

  if (input.acquired.operation.provider_submission_started_at) {
    let existing: calendar_v3.Schema$Event | null;
    try {
      existing = await findCalendarEvent(
        input.calendar,
        input.calendarId,
        input.eventId
      );
    } catch (cause) {
      throw new CalendarProviderOperationStateError(
        "delete_recovery_read",
        { cause }
      );
    }
    if (existing) {
      await failCalendarProviderOperation(
        input.businessId,
        input.operationId,
        input.acquired.claimToken,
        "Provider delete did not apply."
      );
      throw new CalendarProviderOperationStateError(
        "provider_delete_not_applied"
      );
    }
    await markCalendarProviderDeleteApplied(
      input.businessId,
      input.operationId,
      input.acquired.claimToken,
      input.eventId
    );
    await finalizeCalendarProviderOperation(
      input.businessId,
      input.operationId
    );
    return;
  }

  let absenceVerified = false;
  await markCalendarProviderSubmissionStarted(
    input.businessId,
    input.operationId,
    input.acquired.claimToken
  );
  try {
    await input.calendar.events.delete(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        sendUpdates: "all",
      },
      { timeout: CALENDAR_PROVIDER_TIMEOUT_MS, retry: false }
    );
    absenceVerified = true;
  } catch (providerError) {
    if (isGoogleEventNotFound(providerError)) {
      absenceVerified = true;
    } else {
      let recovered: calendar_v3.Schema$Event | null = null;
      let recoveryCompleted = false;
      try {
        recovered = await findCalendarEvent(
          input.calendar,
          input.calendarId,
          input.eventId
        );
        recoveryCompleted = true;
      } catch {
        // A failed recovery read leaves the original outcome ambiguous.
      }
      if (recoveryCompleted && !recovered) {
        absenceVerified = true;
      } else if (isDefinitiveCalendarProviderFailure(providerError)) {
        await failCalendarProviderOperation(
          input.businessId,
          input.operationId,
          input.acquired.claimToken,
          "Google Calendar rejected the delete mutation."
        );
        throw new CalendarProviderOperationConflictError();
      } else {
        throw new CalendarProviderOperationStateError(
          "delete_mutation_ambiguous",
          { cause: providerError }
        );
      }
    }
  }

  if (!absenceVerified) {
    throw new CalendarProviderOperationStateError(
      "delete_absence_unverified"
    );
  }
  await markCalendarProviderDeleteApplied(
    input.businessId,
    input.operationId,
    input.acquired.claimToken,
    input.eventId
  );
  await finalizeCalendarProviderOperation(
    input.businessId,
    input.operationId
  );
}

type CreateOperationContext = {
  calendar: CalendarService;
  calendarId: string;
  businessId: string;
  acquired: AcquiredCalendarProviderOperation;
  operationId: string;
  deterministicEventId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
};

async function completeCreateOperation(
  context: CreateOperationContext
): Promise<CalendarEventResponse> {
  const {
    calendar,
    calendarId,
    businessId,
    acquired,
    operationId,
    deterministicEventId,
    title,
    description,
    startTime,
    endTime,
  } = context;

  if (acquired.operation.status === "provider_applied") {
    const finalized = await finalizeCalendarProviderOperation(
      businessId,
      operationId
    );
    return finalizedOperationResponse(finalized, {
      id: deterministicEventId,
      title,
      start: startTime,
      end: endTime,
    });
  }
  if (acquired.operation.status === "finalized") {
    return finalizedOperationResponse(acquired.operation, {
      id: deterministicEventId,
      title,
      start: startTime,
      end: endTime,
    });
  }

  let providerEvent: calendar_v3.Schema$Event | null = null;
  try {
    providerEvent = await findCalendarEvent(
      calendar,
      calendarId,
      deterministicEventId
    );
  } catch (cause) {
    return handleProviderReadFailure(acquired, cause);
  }

  if (providerEvent) {
    if (!hasCalendarProviderOperationMarker(providerEvent, operationId)) {
      await failCalendarProviderOperation(
        businessId,
        operationId,
        acquired.claimToken,
        "Deterministic provider event identity was already occupied."
      );
      throw new CalendarProviderOperationConflictError();
    }
  } else {
    if (acquired.operation.provider_submission_started_at) {
      await failCalendarProviderOperation(
        businessId,
        operationId,
        acquired.claimToken,
        "Provider create did not apply."
      );
      throw new CalendarProviderOperationStateError(
        "provider_create_not_applied"
      );
    }

    let providerBusy: boolean;
    try {
      providerBusy = await isProviderSlotBusy(
        calendar,
        calendarId,
        startTime,
        endTime
      );
    } catch (cause) {
      return handleProviderReadFailure(acquired, cause);
    }
    if (providerBusy) {
      await failCalendarProviderOperation(
        businessId,
        operationId,
        acquired.claimToken,
        "Provider free-busy reported an occupied interval."
      );
      throw new CalendarProviderSlotUnavailableError();
    }

    await markCalendarProviderSubmissionStarted(
      businessId,
      operationId,
      acquired.claimToken
    );
    try {
      const inserted = await calendar.events.insert(
        {
          calendarId,
          requestBody: {
            id: deterministicEventId,
            summary: title,
            description: description || undefined,
            start: { dateTime: startTime },
            end: { dateTime: endTime },
            reminders: { useDefault: true },
            extendedProperties: {
              private: {
                [CALENDAR_OPERATION_PRIVATE_KEY]: operationId,
              },
            },
          },
        },
        { timeout: CALENDAR_PROVIDER_TIMEOUT_MS, retry: false }
      );
      try {
        providerEvent = await verifyMutationEvent(
          calendar,
          calendarId,
          deterministicEventId,
          operationId,
          inserted.data
        );
      } catch (cause) {
        throw new CalendarProviderOperationStateError(
          "create_evidence_verification",
          { cause }
        );
      }
    } catch (providerError) {
      if (providerError instanceof CalendarProviderOperationStateError) {
        throw providerError;
      }
      providerEvent = await recoverAfterProviderMutationError({
        calendar,
        calendarId,
        providerEventId: deterministicEventId,
        operationId,
        businessId,
        acquired,
        providerError,
      });
    }
  }

  await persistAppliedAndFinalize({
    businessId,
    acquired,
    operationId,
    expectedProviderEventId: deterministicEventId,
    providerEvent,
  });

  return calendarEventResponse(providerEvent, {
    id: deterministicEventId,
    title,
    start: startTime,
    end: endTime,
  });
}

type UpdateOperationContext = {
  calendar: CalendarService;
  calendarId: string;
  businessId: string;
  acquired: AcquiredCalendarProviderOperation;
  operationId: string;
  eventId: string;
  requestBody: Record<string, unknown>;
  existingEvent: calendar_v3.Schema$Event | null;
  desiredStart: string;
  desiredEnd: string;
};

async function completeUpdateOperation(
  context: UpdateOperationContext
): Promise<CalendarEventResponse> {
  const {
    calendar,
    calendarId,
    businessId,
    acquired,
    operationId,
    eventId,
    requestBody,
    desiredStart,
    desiredEnd,
  } = context;
  let providerEvent = context.existingEvent;

  if (acquired.operation.status === "provider_applied") {
    const finalized = await finalizeCalendarProviderOperation(
      businessId,
      operationId
    );
    return finalizedOperationResponse(finalized, {
      id: eventId,
      title: "",
      start: desiredStart,
      end: desiredEnd,
      description: null,
    });
  }
  if (acquired.operation.status === "finalized") {
    return finalizedOperationResponse(acquired.operation, {
      id: eventId,
      title: "",
      start: desiredStart,
      end: desiredEnd,
      description: null,
    });
  }

  if (!providerEvent) {
    try {
      providerEvent = await findCalendarEvent(calendar, calendarId, eventId);
    } catch (providerError) {
      return handleProviderReadFailure(acquired, providerError);
    }
  }

  if (!providerEvent) {
    if (acquired.operation.provider_submission_started_at) {
      await resolveCalendarProviderOperationAbsent(
        businessId,
        operationId,
        acquired.claimToken
      );
    } else {
      await failCalendarProviderOperation(
        businessId,
        operationId,
        acquired.claimToken,
        "Target provider event was absent."
      );
    }
    throw new CalendarProviderOperationConflictError();
  }

  if (
    acquired.operation.provider_submission_started_at &&
    !hasCalendarProviderOperationMarker(providerEvent, operationId)
  ) {
    await failCalendarProviderOperation(
      businessId,
      operationId,
      acquired.claimToken,
      "Provider update did not apply."
    );
    throw new CalendarProviderOperationStateError(
      "provider_update_not_applied"
    );
  }

  if (!hasCalendarProviderOperationMarker(providerEvent, operationId)) {
    const priorPrivateProperties =
      providerEvent.extendedProperties?.private ?? {};
    requestBody.extendedProperties = {
      ...(providerEvent.extendedProperties?.shared
        ? { shared: providerEvent.extendedProperties.shared }
        : {}),
      private: {
        ...priorPrivateProperties,
        [CALENDAR_OPERATION_PRIVATE_KEY]: operationId,
      },
    };

    if (typeof providerEvent.etag !== "string" || !providerEvent.etag.trim()) {
      await failCalendarProviderOperation(
        businessId,
        operationId,
        acquired.claimToken,
        "Provider event did not include a concurrency token."
      );
      throw new CalendarProviderOperationStateError("provider_etag_missing");
    }

    await markCalendarProviderSubmissionStarted(
      businessId,
      operationId,
      acquired.claimToken
    );

    try {
      const patched = await calendar.events.patch(
        {
          calendarId,
          eventId,
          sendUpdates: "all",
          requestBody,
        },
        {
          timeout: CALENDAR_PROVIDER_TIMEOUT_MS,
          retry: false,
          headers: { "If-Match": providerEvent.etag },
        }
      );
      try {
        providerEvent = await verifyMutationEvent(
          calendar,
          calendarId,
          eventId,
          operationId,
          patched.data
        );
      } catch (cause) {
        throw new CalendarProviderOperationStateError(
          "update_evidence_verification",
          { cause }
        );
      }
    } catch (providerError) {
      if (providerError instanceof CalendarProviderOperationStateError) {
        throw providerError;
      }
      providerEvent = await recoverAfterProviderMutationError({
        calendar,
        calendarId,
        providerEventId: eventId,
        operationId,
        businessId,
        acquired,
        providerError,
      });
    }
  }

  await persistAppliedAndFinalize({
    businessId,
    acquired,
    operationId,
    expectedProviderEventId: eventId,
    providerEvent,
  });

  return calendarEventResponse(providerEvent, {
    id: eventId,
    title: "",
    start: desiredStart,
    end: desiredEnd,
    description: null,
  });
}

async function recoverAfterProviderMutationError(input: {
  calendar: CalendarService;
  calendarId: string;
  providerEventId: string;
  operationId: string;
  businessId: string;
  acquired: AcquiredCalendarProviderOperation;
  providerError: unknown;
}): Promise<calendar_v3.Schema$Event> {
  let recovered: calendar_v3.Schema$Event | null = null;
  try {
    recovered = await findCalendarEvent(
      input.calendar,
      input.calendarId,
      input.providerEventId
    );
  } catch {
    // The original provider outcome remains ambiguous when recovery cannot
    // prove absence. Retain the durable hold for an exact retry.
  }

  if (
    recovered &&
    hasCalendarProviderOperationMarker(recovered, input.operationId)
  ) {
    return requireMatchingProviderEvent(
      recovered,
      input.providerEventId,
      input.operationId
    );
  }

  if (
    input.acquired.operation.operation_kind === "update" &&
    isGoogleEventNotFound(input.providerError)
  ) {
    await resolveCalendarProviderOperationAbsent(
      input.businessId,
      input.operationId,
      input.acquired.claimToken
    );
    throw new CalendarProviderOperationConflictError();
  }

  if (isDefinitiveCalendarProviderFailure(input.providerError)) {
    await failCalendarProviderOperation(
      input.businessId,
      input.operationId,
      input.acquired.claimToken,
      "Google Calendar rejected the provider mutation."
    );
    throw new CalendarProviderOperationConflictError();
  }

  throw new CalendarProviderOperationStateError(
    "provider_mutation_ambiguous",
    { cause: input.providerError }
  );
}

async function handleProviderReadFailure(
  acquired: AcquiredCalendarProviderOperation,
  cause: unknown
): Promise<never> {
  // A read/free-busy failure before the durable submission fence cannot have
  // changed Google. Terminalize it so a retry re-runs current business gates.
  // A read failure while recovering an earlier submission remains ambiguous.
  if (!acquired.operation.provider_submission_started_at) {
    try {
      await failCalendarProviderOperation(
        acquired.operation.business_id,
        acquired.operation.id,
        acquired.claimToken,
        "Provider preflight could not be completed."
      );
    } catch (failureError) {
      throw new CalendarProviderOperationStateError("provider_preflight", {
        cause: failureError,
      });
    }
  }
  throw new CalendarProviderOperationStateError("provider_preflight", {
    cause,
  });
}

async function failCalendarProviderOperationBeforeSubmission(
  acquired: AcquiredCalendarProviderOperation,
  reason: string
): Promise<boolean> {
  if (acquired.operation.provider_submission_started_at) return false;
  await failCalendarProviderOperation(
    acquired.operation.business_id,
    acquired.operation.id,
    acquired.claimToken,
    reason
  );
  return true;
}

async function persistAppliedAndFinalize(input: {
  businessId: string;
  acquired: AcquiredCalendarProviderOperation;
  operationId: string;
  expectedProviderEventId: string;
  providerEvent: calendar_v3.Schema$Event;
}): Promise<void> {
  const verified = requireMatchingProviderEvent(
    input.providerEvent,
    input.expectedProviderEventId,
    input.operationId
  );
  const providerStartsAt = calendarEventStart(verified);
  const providerEndsAt = calendarEventEnd(verified);
  if (
    !providerStartsAt ||
    !providerEndsAt ||
    !isFiniteTimestamp(providerStartsAt) ||
    !isFiniteTimestamp(providerEndsAt) ||
    new Date(providerEndsAt) <= new Date(providerStartsAt)
  ) {
    throw new CalendarProviderOperationStateError("provider_interval");
  }

  await markCalendarProviderOperationApplied({
    businessId: input.businessId,
    operationId: input.operationId,
    claimToken: input.acquired.claimToken,
    providerEventId: input.expectedProviderEventId,
    providerStartsAt,
    providerEndsAt,
    evidence: buildCalendarProviderEvidence(verified, input.operationId),
  });
  await finalizeCalendarProviderOperation(input.businessId, input.operationId);
}

function finalizedOperationResponse(
  operation: AcquiredCalendarProviderOperation["operation"],
  fallback: CalendarEventResponse
): CalendarEventResponse {
  if (
    operation.status !== "finalized" ||
    !operation.provider_event_id ||
    !operation.provider_starts_at ||
    !operation.provider_ends_at
  ) {
    throw new CalendarProviderOperationStateError(
      "finalized_operation_shape"
    );
  }
  return {
    ...fallback,
    id: operation.provider_event_id,
    start: operation.provider_starts_at,
    end: operation.provider_ends_at,
  };
}

async function verifyMutationEvent(
  calendar: CalendarService,
  calendarId: string,
  providerEventId: string,
  operationId: string,
  event: calendar_v3.Schema$Event
): Promise<calendar_v3.Schema$Event> {
  if (
    event.id === providerEventId &&
    event.status !== "cancelled" &&
    hasCalendarProviderOperationMarker(event, operationId) &&
    calendarEventStart(event) &&
    calendarEventEnd(event)
  ) {
    return event;
  }
  return requireMarkedCalendarEvent(
    calendar,
    calendarId,
    providerEventId,
    operationId
  );
}

async function requireMarkedCalendarEvent(
  calendar: CalendarService,
  calendarId: string,
  providerEventId: string,
  operationId: string
): Promise<calendar_v3.Schema$Event> {
  const event = await getCalendarEvent(
    calendar,
    calendarId,
    providerEventId
  );
  return requireMatchingProviderEvent(event, providerEventId, operationId);
}

function requireMatchingProviderEvent(
  event: calendar_v3.Schema$Event,
  providerEventId: string,
  operationId: string
): calendar_v3.Schema$Event {
  if (
    event.id !== providerEventId ||
    event.status === "cancelled" ||
    !hasCalendarProviderOperationMarker(event, operationId)
  ) {
    throw new CalendarProviderOperationStateError("provider_identity");
  }
  return event;
}

async function getCalendarEvent(
  calendar: CalendarService,
  calendarId: string,
  eventId: string
): Promise<calendar_v3.Schema$Event> {
  const response = await calendar.events.get(
    { calendarId, eventId },
    { timeout: CALENDAR_PROVIDER_TIMEOUT_MS, retry: false }
  );
  if (response.data.id !== eventId) {
    throw new CalendarProviderOperationStateError(
      "provider_event_identity"
    );
  }
  return response.data;
}

async function findCalendarEvent(
  calendar: CalendarService,
  calendarId: string,
  eventId: string
): Promise<calendar_v3.Schema$Event | null> {
  try {
    const event = await getCalendarEvent(calendar, calendarId, eventId);
    return event.status === "cancelled" ? null : event;
  } catch (error) {
    if (isGoogleEventNotFound(error)) return null;
    throw error;
  }
}

async function isProviderSlotBusy(
  calendar: CalendarService,
  calendarId: string,
  startsAt: string,
  endsAt: string
): Promise<boolean> {
  const response = await calendar.freebusy.query(
    {
      requestBody: {
        timeMin: startsAt,
        timeMax: endsAt,
        items: [{ id: calendarId }],
      },
    },
    { timeout: CALENDAR_PROVIDER_TIMEOUT_MS, retry: false }
  );
  const calendars = response.data.calendars;
  const calendarEntry = calendars?.[calendarId];
  if (
    !calendars ||
    !Object.hasOwn(calendars, calendarId) ||
    !calendarEntry ||
    !Array.isArray(calendarEntry.busy) ||
    (calendarEntry.errors !== undefined &&
      (!Array.isArray(calendarEntry.errors) ||
        calendarEntry.errors.length > 0))
  ) {
    throw new CalendarProviderOperationStateError(
      "provider_freebusy_response"
    );
  }
  const busy = calendarEntry.busy;
  const requestedStart = Date.parse(startsAt);
  const requestedEnd = Date.parse(endsAt);
  return busy.some((period) => {
    if (typeof period.start !== "string" || typeof period.end !== "string") {
      throw new CalendarProviderOperationStateError(
        "provider_freebusy_interval"
      );
    }
    const busyStart = Date.parse(period.start);
    const busyEnd = Date.parse(period.end);
    if (
      !Number.isFinite(busyStart) ||
      !Number.isFinite(busyEnd) ||
      busyEnd <= busyStart
    ) {
      throw new CalendarProviderOperationStateError(
        "provider_freebusy_interval"
      );
    }
    return busyStart < requestedEnd && busyEnd > requestedStart;
  });
}

function calendarEventStart(event: calendar_v3.Schema$Event): string | null {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

function calendarEventEnd(event: calendar_v3.Schema$Event): string | null {
  return event.end?.dateTime ?? event.end?.date ?? null;
}

function calendarEventResponse(
  event: calendar_v3.Schema$Event,
  fallback: CalendarEventResponse
): CalendarEventResponse {
  return {
    id: event.id ?? fallback.id,
    title: event.summary ?? fallback.title,
    start: calendarEventStart(event) ?? fallback.start,
    end: calendarEventEnd(event) ?? fallback.end,
    ...(Object.hasOwn(fallback, "description")
      ? { description: event.description ?? fallback.description ?? null }
      : {}),
  };
}

function isFiniteTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function calendarProviderNamespace(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    calendar_id?: unknown;
    google_email?: unknown;
  };
  if (
    typeof candidate.calendar_id !== "string" ||
    typeof candidate.google_email !== "string"
  ) {
    return null;
  }
  const calendarId = candidate.calendar_id.trim();
  const googleEmail = candidate.google_email.trim().toLowerCase();
  if (!calendarId || !googleEmail) return null;
  // Kept only in request memory for preflight/post-hold equality; never logged
  // or written to the provider-operation lifecycle table.
  return `${googleEmail}\n${calendarId}`;
}

function calendarOperationErrorResponse(error: unknown): NextResponse | null {
  if (
    error instanceof CalendarProviderSlotUnavailableError ||
    error instanceof CalendarProviderOperationConflictError
  ) {
    return NextResponse.json(
      { error: "calendar_time_unavailable", retryable: false },
      { status: 409 }
    );
  }
  if (
    error instanceof CalendarProviderOperationBusyError ||
    error instanceof CalendarProviderOperationStateError
  ) {
    return NextResponse.json(
      { error: "calendar_operation_unavailable", retryable: true },
      { status: 503 }
    );
  }
  return null;
}

function recordDashboardBookingMetric(
  businessId: string,
  calendarId: string,
  providerEventId: string
): void {
  try {
    recordBusinessMetricEventBestEffort({
      businessId,
      metricKey: "booking_confirmed",
      quantity: 1,
      occurredAt: new Date(),
      sourceKey: buildDashboardBookingSourceKey(
        businessId,
        calendarId,
        providerEventId
      ),
      origin: "dashboard",
    });
  } catch {
    console.error("[metrics] Metric dispatch failed:", {
      businessId,
      metricKey: "booking_confirmed",
    });
  }
}

function logSanitizedCalendarFailure(
  operation: "read" | "create" | "update" | "delete",
  error: unknown
): void {
  let providerStatus: number | null = null;
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      response?: { status?: unknown };
    };
    const value = candidate.response?.status ?? candidate.code;
    if (typeof value === "number" && Number.isInteger(value)) {
      providerStatus = value;
    } else if (typeof value === "string" && /^\d{3}$/.test(value)) {
      providerStatus = Number(value);
    }
  }
  console.error("[calendar/events] Calendar mutation failed", {
    operation,
    providerStatus,
    category:
      error instanceof Error ? error.constructor.name : "UnknownFailure",
  });
}

function workspaceChangedResponse(): NextResponse {
  return NextResponse.json(
    { error: "workspace_access_unavailable", retryable: true },
    { status: 503 }
  );
}

function calendarGoalUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "goal_unavailable", feature: "calendar" },
    { status: 403 }
  );
}

async function bookingCreationOperationalResponse(
  businessId: string
): Promise<NextResponse | null> {
  try {
    await assertBookingOperationallyAllowed(businessId);
    return null;
  } catch (error) {
    if (isBookingOperationalBlockedError(error)) {
      return NextResponse.json(
        {
          error: "booking_creation_unavailable",
          reason: error.reason,
        },
        { status: 403 }
      );
    }
    if (
      isOperationalControlsResolutionError(error) ||
      isBookingOperationalStateError(error)
    ) {
      return NextResponse.json(
        { error: "service_state_unavailable", retryable: true },
        { status: 503 }
      );
    }
    throw error;
  }
}
