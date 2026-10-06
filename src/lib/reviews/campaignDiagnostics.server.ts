import "server-only";

export interface CampaignErrorOptions {
  /** Known private filing values and credentials, never included in the result. */
  sensitiveValues?: readonly string[];
}

export interface CampaignProviderError {
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
}

export interface CampaignErrorCause {
  name: string;
  message: string;
  code?: string;
  cause?: CampaignErrorCause;
}

export interface SerializedCampaignError {
  name: string;
  message: string;
  status: number | null;
  requestId: string | null;
  providerErrors: CampaignProviderError[];
  providerErrorsTruncated?: true;
  cause?: CampaignErrorCause;
}

const maxInputLength = 32_000;
const maxProviderErrors = 8;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function privateValues(options: CampaignErrorOptions): string[] {
  return Array.from(new Set((options.sensitiveValues ?? [])
    .filter((value) => typeof value === "string" && value.trim().length >= 3)
    .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])))
    .sort((a, b) => b.length - a.length);
}

function sanitize(value: unknown, secrets: readonly string[], limit = 700): string | undefined {
  let text = scalar(value);
  if (text === undefined) return undefined;
  if (text.length > maxInputLength) return "[oversized diagnostic omitted]";
  // Error.message often embeds the entire provider response or a request object.
  // Structured provider fields are captured separately through an allowlist.
  text = text.replace(/(?:\{|\[\s*(?:\{|"|[-\d]|true\b|false\b|null\b))[\s\S]*/, "[structured data omitted]");
  for (const secret of secrets) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  text = text
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential]")
    .replace(/\b(?:KEY[A-Za-z0-9_-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[credential]")
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|token|credential|ein|tax[_ -]?(?:id|number)|address|street|city|zip|postal[_ -]?code|legal[_ -]?business[_ -]?name|authorized[_ -]?rep[_ -]?name))\s*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;\r\n}]+)/gi, "$1: [redacted]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?<![A-Za-z0-9])(?:\+\d(?:[ ().-]*\d){7,14}|(?:1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4})(?![A-Za-z0-9])/g, "[phone]")
    .replace(/\b(?:\d{2}[- ]\d{7}|\d{3}-\d{2}-\d{4}|\d{9})\b/g, "[tax-id]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function errorName(error: unknown, secrets: readonly string[]): string {
  const name = field(error, "name");
  const className = field(field(error, "constructor"), "name");
  return sanitize(name === "Error" && className !== "Object" ? className ?? name : name, secrets, 80)
    || "UnknownError";
}

function errorCause(error: unknown, secrets: readonly string[], depth = 0): CampaignErrorCause | undefined {
  if (error === undefined || error === null || depth > 1) return undefined;
  const message = sanitize(field(error, "message") ?? scalar(error), secrets, 500) || "No error message supplied";
  const code = sanitize(field(error, "code"), secrets, 80);
  const cause = errorCause(field(error, "cause"), secrets, depth + 1);
  return { name: errorName(error, secrets), message, ...(code ? { code } : {}), ...(cause ? { cause } : {}) };
}

function providerError(value: unknown, secrets: readonly string[]): CampaignProviderError | null {
  const code = sanitize(field(value, "code") ?? field(value, "type"), secrets, 80);
  const title = sanitize(field(value, "title"), secrets, 200);
  const detail = sanitize(field(value, "detail") ?? field(value, "msg") ?? field(value, "message"), secrets);
  const sourceValue = field(value, "source");
  const loc = field(value, "loc");
  const location = Array.isArray(loc)
    ? `/${loc.slice(0, 12).map((part) => (scalar(part) ?? "").replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
    : undefined;
  const pointer = sanitize(field(sourceValue, "pointer") ?? location, secrets, 240);
  const parameter = sanitize(field(sourceValue, "parameter"), secrets, 120);
  const source = pointer || parameter ? { ...(pointer ? { pointer } : {}), ...(parameter ? { parameter } : {}) } : undefined;
  if (!code && !title && !detail && !source) return null;
  return { ...(code ? { code } : {}), ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(source ? { source } : {}) };
}

function requestId(error: unknown, secrets: readonly string[]): string | null {
  const headers = field(error, "headers");
  const candidates = [field(error, "request_id"), field(error, "requestId")];
  for (const key of ["x-request-id", "x-telnyx-request-id", "request-id"]) {
    try {
      candidates.push(headers instanceof Headers ? headers.get(key) : field(headers, key));
    } catch {
      // A malformed error/header object must not replace the original failure.
    }
  }
  for (const value of candidates) {
    if (typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value)
      && !/^(?:KEY|(?:sk|rk|pk)_(?:live|test)_)/.test(value)
      && !/^\d{9,11}$/.test(value)
      && !secrets.some((secret) => value.toLowerCase().includes(secret.toLowerCase())))
      return value;
  }
  return null;
}

/** Deliberately excludes stack, headers, request/body, input, and raw response. */
export function serializeCampaignError(error: unknown, options: CampaignErrorOptions = {}): SerializedCampaignError {
  const secrets = privateValues(options);
  const rawStatus = field(error, "status") ?? field(error, "statusCode");
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus : null;
  const body = field(error, "error");
  const errors = field(body, "errors") ?? field(error, "errors");
  const validation = field(body, "detail");
  const values = Array.isArray(errors) ? errors : Array.isArray(body) ? body : Array.isArray(validation) ? validation : [body];
  const providerErrors = values.slice(0, maxProviderErrors)
    .map((value) => providerError(value, secrets)).filter((value): value is CampaignProviderError => value !== null);
  const cause = errorCause(field(error, "cause"), secrets);
  const result: SerializedCampaignError = {
    name: errorName(error, secrets),
    message: sanitize(field(error, "message") ?? scalar(error), secrets, 1000) || "No error message supplied",
    status,
    requestId: requestId(error, secrets),
    providerErrors,
    ...(values.length > maxProviderErrors ? { providerErrorsTruncated: true as const } : {}),
    ...(cause ? { cause } : {}),
  };
  // The journal enforces a 16 KiB JSON limit; leave room for JSONB formatting
  // and caller metadata, including when provider text contains multibyte Unicode.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 14_000 && result.providerErrors.length > 1) {
    result.providerErrors.pop();
    result.providerErrorsTruncated = true;
  }
  return result;
}

export interface CampaignErrorLogInput {
  businessId: string;
  operationId?: string | null;
  attemptId?: string | null;
  reservationId?: string | null;
  referenceId?: string | null;
  payloadHash?: string | null;
  phase: string;
  error: SerializedCampaignError;
}

/** Call with serializeCampaignError's result; never pass the provider error. */
export function logCampaignError(input: CampaignErrorLogInput): void {
  const identifiers = Object.fromEntries(
    ["businessId", "operationId", "attemptId", "reservationId"].flatMap((key) => {
      const value = field(input, key);
      return typeof value === "string" && uuid.test(value) ? [[key, value]] : [];
    }),
  );
  const referenceId = input.referenceId && /^(?:reviews|upgrade):[0-9a-f-]{36}(?::r1)?$/i.test(input.referenceId)
    ? input.referenceId : undefined;
  const payloadHash = input.payloadHash && /^[a-f0-9]{64}$/.test(input.payloadHash) ? input.payloadHash : undefined;
  // Reapply the field allowlist so unexpected properties added by a caller can
  // never turn a structured diagnostic into raw request/response logging.
  const error = serializeCampaignError({
    name: input.error.name,
    message: input.error.message,
    status: input.error.status,
    requestId: input.error.requestId,
    error: { errors: input.error.providerErrors },
    cause: input.error.cause,
  });
  if (input.error.providerErrorsTruncated) error.providerErrorsTruncated = true;
  console.error("[reviews:campaign]", JSON.stringify({
    event: "campaign_submission_failed",
    ...identifiers,
    ...(referenceId ? { referenceId } : {}),
    ...(payloadHash ? { payloadHash } : {}),
    phase: /^[a-z_]{1,40}$/.test(input.phase) ? input.phase : "unknown",
    error,
  }));
}
