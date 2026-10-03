import { telnyx } from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  beginProviderCreateIntent,
  resolveProviderCreateIntent,
} from "@/lib/messaging/registration/providerCreateIntent";

const TELNYX_NUMBER_ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TELNYX_PHONE_NUMBER_RESOURCE_ID_PATTERN = /^[0-9]+$/;

const NANP_TOLL_FREE_AREA_CODES = new Set([
  "800",
  "833",
  "844",
  "855",
  "866",
  "877",
  "888",
]);

export const NUMBER_ORDER_CREATE_INTENT_SPEC = {
  eventType: "phone_number_order_create_intent",
  resourceType: "phone_number",
} as const;

/**
 * Normalize the ID accepted by Telnyx's managed `/phone_numbers/{id}` APIs.
 *
 * This ID is a decimal string, not the UUID returned for a
 * `number_order_phone_number` child. Keep it as a string because current
 * Telnyx IDs exceed JavaScript's safe-integer range.
 */
export function normalizeTelnyxPhoneNumberResourceId(
  value: unknown,
  context: string
): string {
  if (
    typeof value !== "string" ||
    !TELNYX_PHONE_NUMBER_RESOURCE_ID_PATTERN.test(value.trim())
  ) {
    throw new Error(
      `[messaging:numbers] Invalid Telnyx phone number resource id ${context}`
    );
  }
  return value.trim();
}

function normalizeOptionalNumberOrderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return TELNYX_NUMBER_ORDER_ID_PATTERN.test(trimmed)
    ? trimmed.toLowerCase()
    : undefined;
}

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
}

/**
 * Return whether a US/Canadian NANP number uses a currently assigned
 * toll-free NPA. Accept common display punctuation, but require an exact
 * 10-digit national number (optionally prefixed by country code 1).
 */
export function isNanpTollFreeNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  const nationalNumber =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  return (
    nationalNumber.length === 10 &&
    NANP_TOLL_FREE_AREA_CODES.has(nationalNumber.slice(0, 3))
  );
}

export async function searchAvailableNumbers(
  areaCode: string
): Promise<AvailableNumber[]> {
  const result = await telnyx.availablePhoneNumbers.list({
    filter: {
      country_code: "US",
      national_destination_code: areaCode,
      phone_number_type: "local",
      features: ["sms", "voice"],
      best_effort: false,
      limit: 10,
    },
  });

  return (
    result.data
      ?.filter((n): n is { phone_number: string; vanity_format?: string } =>
        typeof n.phone_number === "string" &&
        !isNanpTollFreeNumber(n.phone_number)
      )
      .map((n) => ({
        phoneNumber: n.phone_number,
        friendlyName: n.vanity_format ?? n.phone_number,
      })) ?? []
  );
}

export interface PurchasedNumber {
  phoneNumber: string;
  // Managed /phone_numbers resource ID (decimal string). Stored in
  // phone_numbers.telnyx_phone_number_id and used for routing updates.
  phoneNumberId: string;
  // Provenance only. Neither UUID is valid for /phone_numbers/{id}.
  numberOrderId?: string;
  numberOrderPhoneNumberId?: string;
  providerCreateIntentId: string;
  status: "pending" | "success" | "failure" | undefined;
}

// Thrown after Telnyx has accepted a potentially charged number order but a
// complete owned-number listing cannot prove the one managed /phone_numbers
// resource ID. Retry must recover ownership; it must not place another order.
export class PurchasedNumberResolutionError extends Error {
  readonly phoneNumber: string;
  readonly numberOrderId?: string;
  readonly numberOrderPhoneNumberId?: string;
  readonly status: PurchasedNumber["status"];
  readonly providerCreateIntentId: string;

  constructor(args: {
    phoneNumber: string;
    numberOrderId?: string;
    numberOrderPhoneNumberId?: string;
    status: PurchasedNumber["status"];
    providerCreateIntentId: string;
    cause: unknown;
  }) {
    super(
      `[messaging:numbers] Number order accepted for ${args.phoneNumber}, but the managed Telnyx phone number resource id could not be resolved`,
      { cause: args.cause }
    );
    this.name = "PurchasedNumberResolutionError";
    this.phoneNumber = args.phoneNumber;
    this.numberOrderId = args.numberOrderId;
    this.numberOrderPhoneNumberId = args.numberOrderPhoneNumberId;
    this.status = args.status;
    this.providerCreateIntentId = args.providerCreateIntentId;
  }
}

// Thrown when a number was PURCHASED at Telnyx but the local phone_numbers
// insert failed — the purchase-save two-phase-commit gap. Typed so callers
// classify by construction instead of message-sniffing: this is NOT
// "number unavailable" (the customer was charged; a retry must recover the
// owned number, never re-purchase or re-pick).
export class PurchasedNumberSaveError extends Error {
  readonly phoneNumber: string;
  readonly telnyxPhoneNumberId: string;

  constructor(args: {
    phoneNumber: string;
    telnyxPhoneNumberId: string;
    cause: unknown;
  }) {
    super(
      `[messaging:numbers] Number ${args.phoneNumber} purchased at Telnyx (id=${args.telnyxPhoneNumberId}) but the local save failed`,
      { cause: args.cause }
    );
    this.name = "PurchasedNumberSaveError";
    this.phoneNumber = args.phoneNumber;
    this.telnyxPhoneNumberId = args.telnyxPhoneNumberId;
  }
}

// Thrown when the pending number is actively held by ANOTHER business —
// typed so classification is by construction (the collision genuinely is
// "unavailable", but message-sniffing for it would recreate the coupling
// the save-error type exists to remove).
export class NumberTakenError extends Error {
  constructor(phoneNumber: string) {
    super(
      `[messaging:numbers] Number ${phoneNumber} is already held by another business`
    );
    this.name = "NumberTakenError";
  }
}

/**
 * The selected inventory item was synchronously rejected by Telnyx as no
 * longer orderable. This type is constructed only after the exact provider
 * rejection is proven and its matching pre-POST intent is resolved.
 */
export class NumberUnavailableError extends Error {
  readonly phoneNumber: string;

  constructor(phoneNumber: string, cause: unknown) {
    super(
      `[messaging:numbers] Number ${phoneNumber} is no longer available to order`,
      { cause }
    );
    this.name = "NumberUnavailableError";
    this.phoneNumber = phoneNumber;
  }
}

/** A toll-free number cannot enter this local-number + 10DLC launch path. */
export class TollFreeNumberUnsupportedError extends Error {
  readonly phoneNumber: string;

  constructor(phoneNumber: string) {
    super(
      `[messaging:numbers] Toll-free number ${phoneNumber} is not supported by the local 10DLC registration flow`
    );
    this.name = "TollFreeNumberUnsupportedError";
    this.phoneNumber = phoneNumber;
  }
}

// Recovery lookup for the purchase-save gap: did THIS BUSINESS already
// purchase this exact number? Scoped by customer_reference (stamped on
// every order) — on a single Telnyx account, matching by phone number alone
// would let business B "recover" a number business A just paid for. The
// iterator must finish before any match is trusted: a later page can reveal a
// duplicate, and a mid-pagination failure makes the result ambiguous.
export async function findOwnedNumberId(
  phoneNumber: string,
  businessId: string
): Promise<string | null> {
  // Digits-only for the filter: the SDK documents "non-numerical characters
  // will result in no values being returned" for filter[phone_number].
  // (Empirically a URL-encoded '+' also matches, verified against prod
  // 2026-07-15 — digits-only satisfies both the documented contract and
  // observed behavior.) The response itself is +E.164, so the equality
  // check below keeps the full-format match.
  const digitsOnly = phoneNumber.replace(/\D/g, "");
  const result = await telnyx.phoneNumbers.list({
    filter: { phone_number: digitsOnly, customer_reference: businessId },
  });

  const exactMatches: Array<{
    id?: string;
    phone_number?: string;
    customer_reference?: string | null;
    record_type?: string;
  }> = [];
  for await (const candidate of result) {
    if (
      candidate.phone_number === phoneNumber &&
      candidate.customer_reference === businessId &&
      candidate.record_type === "phone_number"
    ) {
      exactMatches.push(candidate);
    }
  }

  if (exactMatches.length === 0) return null;
  if (exactMatches.length !== 1) {
    throw new Error(
      `[messaging:numbers] Ambiguous Telnyx ownership lookup for ${phoneNumber} and business ${businessId}: found ${exactMatches.length} exact matches`
    );
  }

  return normalizeTelnyxPhoneNumberResourceId(
    exactMatches[0].id,
    `returned while recovering ${phoneNumber} for business ${businessId}`
  );
}

export async function getActivePhoneNumberForBusiness(
  businessId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("phone_numbers")
    .select("phone_number")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[messaging:numbers] Failed to read active phone number for ${businessId}: ${error.message}`
    );
  }

  return data?.phone_number ?? null;
}

export async function purchaseNumber(
  phoneNumber: string,
  businessId: string,
  options?: { beforePaidSubmit: () => Promise<void> },
): Promise<PurchasedNumber> {
  // Defense in depth: search requests local inventory and filters toll-free
  // responses, but a stale client or direct request must still be rejected
  // before the durable intent or paid Telnyx POST.
  if (isNanpTollFreeNumber(phoneNumber)) {
    throw new TollFreeNumberUnsupportedError(phoneNumber);
  }

  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select("telnyx_messaging_profile_id, telnyx_voice_application_id")
    .eq("id", businessId)
    .single();

  if (readError || !business) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} not found: ${readError?.message ?? "not found"}`
    );
  }

  if (!business.telnyx_messaging_profile_id) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} has no telnyx_messaging_profile_id — complete brand verification before purchasing a number`
    );
  }

  if (!business.telnyx_voice_application_id) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} has no telnyx_voice_application_id — complete brand verification before purchasing a number`
    );
  }

  await options?.beforePaidSubmit();

  // Persist the ambiguity fence before the paid POST. If the request reaches
  // Telnyx but its response is lost, Retry must recover this exact owned
  // number (or require reconciliation); it may never authorize another order
  // from a temporarily empty provider list.
  const providerCreateIntentId = await beginProviderCreateIntent({
    businessId,
    spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
    rawPayload: { phoneNumber },
  });

  let order: Awaited<ReturnType<typeof telnyx.numberOrders.create>>;
  try {
    order = await telnyx.numberOrders.create(
      {
        phone_numbers: [{ phone_number: phoneNumber }],
        connection_id: business.telnyx_voice_application_id,
        messaging_profile_id: business.telnyx_messaging_profile_id,
        customer_reference: businessId,
      },
      // Avoid an automatic second paid request. The durable intent above
      // also blocks a later user Retry after an ambiguous transport outcome.
      { maxRetries: 0 }
    );
  } catch (cause) {
    if (isDefiniteNumberUnavailableRejection(cause, phoneNumber)) {
      await resolveProviderCreateIntent({
        businessId,
        spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
        intentId: providerCreateIntentId,
      });
      throw new NumberUnavailableError(phoneNumber, cause);
    }
    throw cause;
  }

  if (order.data?.status === "failure") {
    // This is an explicit provider response saying the order failed, not an
    // ambiguous transport outcome. No number was created by this attempt.
    await resolveProviderCreateIntent({
      businessId,
      spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
      intentId: providerCreateIntentId,
    });
    throw new Error(
      `Telnyx number order failed for ${phoneNumber}: ${JSON.stringify(order.data)}`
    );
  }

  const numberOrderId = normalizeOptionalNumberOrderId(order.data?.id);
  const orderPhoneNumber = order.data?.phone_numbers?.find(
    (candidate) => candidate.phone_number === phoneNumber
  );
  const numberOrderPhoneNumberId = normalizeOptionalNumberOrderId(
    orderPhoneNumber?.id
  );

  let phoneNumberId: string;
  try {
    const ownedId = await findOwnedNumberId(phoneNumber, businessId);
    if (!ownedId) {
      throw new Error(
        `[messaging:numbers] Complete Telnyx ownership lookup returned no exact match for ${phoneNumber} and business ${businessId}`
      );
    }
    phoneNumberId = ownedId;
  } catch (cause) {
    throw new PurchasedNumberResolutionError({
      phoneNumber,
      numberOrderId,
      numberOrderPhoneNumberId,
      status: order.data?.status,
      providerCreateIntentId,
      cause,
    });
  }

  return {
    phoneNumber,
    phoneNumberId,
    ...(numberOrderId ? { numberOrderId } : {}),
    ...(numberOrderPhoneNumberId ? { numberOrderPhoneNumberId } : {}),
    providerCreateIntentId,
    status: order.data?.status,
  };
}

function isDefiniteNumberUnavailableRejection(
  error: unknown,
  requestedPhoneNumber: string
): boolean {
  if (!error || typeof error !== "object") return false;
  const providerError = error as {
    status?: unknown;
    error?: {
      errors?: Array<{
        code?: unknown;
        detail?: unknown;
        source?: { pointer?: unknown };
      }>;
    };
  };
  if (providerError.status !== 422) return false;

  const expectedDetail = `We don't recognize the number(s) ['${requestedPhoneNumber}']. Did you first search for the number(s)?`;

  return Boolean(
    providerError.error?.errors?.some(
      (item) =>
        String(item.code) === "10027" &&
        item.source?.pointer === "/" &&
        item.detail === expectedDetail
    )
  );
}

export async function attachOwnedNumberToCustomerProfile(
  businessId: string,
  phoneNumberId: string
): Promise<void> {
  // A legacy row may contain a number-order child UUID. That identifier must
  // never be trusted or sent to managed /phone_numbers endpoints. Validate
  // before any database read or provider-facing routing update.
  const normalizedPhoneNumberId = normalizeTelnyxPhoneNumberResourceId(
    phoneNumberId,
    `stored for business ${businessId}`
  );

  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select("telnyx_messaging_profile_id, telnyx_voice_application_id")
    .eq("id", businessId)
    .single();

  if (readError || !business) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} not found: ${readError?.message ?? "not found"}`
    );
  }

  if (!business.telnyx_messaging_profile_id) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} has no telnyx_messaging_profile_id — cannot attach owned number`
    );
  }

  if (!business.telnyx_voice_application_id) {
    throw new Error(
      `[messaging:numbers] Business ${businessId} has no telnyx_voice_application_id — cannot attach owned number`
    );
  }

  await telnyx.phoneNumbers.update(normalizedPhoneNumberId, {
    connection_id: business.telnyx_voice_application_id,
    customer_reference: businessId,
  });
  await telnyx.phoneNumbers.messaging.update(normalizedPhoneNumberId, {
    messaging_profile_id: business.telnyx_messaging_profile_id,
  });
}
