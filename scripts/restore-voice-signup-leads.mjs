#!/usr/bin/env node

// A bounded repair of existing history. No messaging/provider client or billing
// writer is imported. The only write is the service-only bookkeeping RPC.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const manifest = JSON.parse(readFileSync(
  new URL("./voice-signup-restore.manifest.json", import.meta.url), "utf8",
));
export const RESTORE_MANIFEST = Object.freeze({
  version: manifest.version,
  businessId: manifest.businessId,
  actions: Object.freeze(manifest.actions.map((entry) => Object.freeze(entry))),
});

const ACTION_COLUMNS = "id,session_id,business_id,kind,status,confirmed_at,source_message_id,confirmation_event_ids,result,sms_provider_message_id,sms_accepted_at,sms_logged_at";
const MESSAGE_COLUMNS = "id,business_id,conversation_id,role,channel,content,created_at";
const CONVERSATION_COLUMNS = "id,business_id,contact_id,channel";
const EVENT_COLUMNS = "id,business_id,contact_id,conversation_id,source_message_id,assistant_message_id,goal_at_event,event_type,channel,occurred_at,idempotency_key,voice_action_id,origin_kind,source_conversation_id,time_source";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP = `Usage: node scripts/restore-voice-signup-leads.mjs [--dry-run | --apply]

Dry-run is the default. Only the three actions in the checked-in manifest are
eligible. --apply rechecks each action and invokes the transactional bookkeeping
RPC. It never sends texts, calls a provider, or records billing usage.

Required environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
No environment files or external credential helpers are loaded by this script.

Original time: sms_accepted_at, otherwise the existing SMS message created_at.
The fallback is reported as message_recorded, not provider acceptance time.
Any rejected preflight row prevents all writes. An apply-time failure can leave
earlier rows restored; a repeat run safely reports them as already present.
Exit codes: 0 = all checks passed, 2 = rejected rows, 1 = setup failure.`;

class RestoreGuardError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireGuard(value, code) {
  if (!value) throw new RestoreGuardError(code);
}

export function parseArguments(argv) {
  const parsed = { apply: false, help: false };
  let mode;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--apply" || argument === "--dry-run") {
      requireGuard(!mode, "choose_one_mode_once");
      mode = argument;
      parsed.apply = argument === "--apply";
    } else throw new RestoreGuardError("unsupported_argument");
  }
  return parsed;
}

export function validateEnvironment(environment) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  requireGuard(url, "missing_supabase_url");
  requireGuard(key, "missing_service_role_key");
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new RestoreGuardError("invalid_supabase_url"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  requireGuard(!parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.pathname === "/"
    && (local ? ["http:", "https:"].includes(parsed.protocol)
      : parsed.protocol === "https:" && parsed.hostname.endsWith(".supabase.co")),
  "invalid_supabase_url");
  return { url: parsed.origin, key };
}

// Preserve PostgreSQL fractional seconds when comparing timestamps. Date alone
// would silently consider two different microsecond timestamps equal.
function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}T${match[2]}${match[4]}`);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * 1000000n + BigInt((match[3] || "").padEnd(9, "0"));
}

function sameTime(left, right) {
  const instant = timestamp(left);
  return instant !== null && instant === timestamp(right);
}

async function one(db, table, columns, filters, code) {
  let query = db.from(table).select(columns);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { data, error } = await query.maybeSingle();
  requireGuard(!error && data, code);
  return data;
}

async function rows(query, code) {
  const { data, error } = await query;
  requireGuard(!error && Array.isArray(data), code);
  return data;
}

function eventMatches(event, snapshot) {
  const { action, sms, source, contact, occurredAt, timeSource } = snapshot;
  return UUID.test(event.id) && event.business_id === action.business_id
    && event.contact_id === contact.id && event.conversation_id === sms.conversation_id
    && event.source_message_id === source.id && event.assistant_message_id === sms.id
    && event.goal_at_event === "signup" && event.event_type === "link_sent"
    && event.channel === "sms" && event.voice_action_id === action.id
    && event.origin_kind === "voice_action" && event.source_conversation_id === source.conversation_id
    && event.idempotency_key === `voice-signup:${action.id}`
    && event.time_source === timeSource && sameTime(event.occurred_at, occurredAt);
}

export async function inspectRestoreAction(db, entry) {
  // No caller-supplied manifest, business, or action IDs can expand this repair.
  requireGuard(RESTORE_MANIFEST.actions.some((approved) =>
    approved.actionId === entry.actionId && approved.sessionId === entry.sessionId),
  "action_not_in_manifest");
  const businessId = RESTORE_MANIFEST.businessId;
  const [business, action, session, sms] = await Promise.all([
    one(db, "businesses", "id,owner_id,deleted_at,cleanup_pii_scrubbed_at", { id: businessId }, "business_missing"),
    one(db, "voice_actions", ACTION_COLUMNS, { id: entry.actionId }, "action_missing"),
    one(db, "voice_sessions", "id,business_id,response_mode,demo_mode,action_business_id,conversation_id,action_conversation_id,caller_phone,called_phone", { id: entry.sessionId }, "session_missing"),
    one(db, "messages", MESSAGE_COLUMNS, { id: entry.actionId }, "original_sms_missing"),
  ]);
  requireGuard(business.id === businessId && business.owner_id && !business.deleted_at
    && !business.cleanup_pii_scrubbed_at, "business_not_retained");
  requireGuard(action.id === entry.actionId && action.session_id === entry.sessionId
    && action.business_id === businessId, "action_scope_mismatch");
  requireGuard(action.kind === "signup" && action.status === "succeeded"
    && timestamp(action.confirmed_at) !== null && UUID.test(action.source_message_id),
  "action_not_confirmed_successful_signup");
  requireGuard(session.id === entry.sessionId && session.business_id === businessId
    && session.response_mode === "voice" && session.demo_mode === false
    && (session.action_business_id ?? session.business_id) === businessId,
  "session_scope_mismatch");
  const voiceConversationId = session.action_conversation_id || session.conversation_id;
  requireGuard(UUID.test(voiceConversationId) && /^\+[1-9]\d{7,14}$/.test(session.caller_phone)
    && /^\+[1-9]\d{7,14}$/.test(session.called_phone), "session_identity_missing");
  const providerId = action.result?.providerMessageId;
  requireGuard(typeof providerId === "string" && providerId.trim() === providerId
    && providerId.length > 0 && providerId.length <= 256
    && action.result?.deliveryStatus === "delivered", "verified_delivery_missing");
  requireGuard(!action.sms_provider_message_id || action.sms_provider_message_id === providerId,
    "provider_identity_mismatch");
  requireGuard(typeof action.result?.smsBody === "string" && action.result.smsBody.length > 0
    && sms.id === action.id && sms.business_id === businessId && sms.role === "assistant"
    && sms.channel === "sms" && sms.content === action.result.smsBody,
  "original_sms_mismatch");
  requireGuard(UUID.test(sms.conversation_id), "sms_conversation_missing");
  const confirmationIds = action.confirmation_event_ids;
  requireGuard(Array.isArray(confirmationIds) && confirmationIds.length > 0
    && confirmationIds.length <= 100 && new Set(confirmationIds).size === confirmationIds.length
    && confirmationIds.every((id) => typeof id === "string" && id.length > 0),
  "confirmation_evidence_missing");

  const [source, voiceConversation, smsConversation, usage, providerActions, acceptedActions, fragments, events] = await Promise.all([
    one(db, "messages", MESSAGE_COLUMNS, { id: action.source_message_id }, "source_confirmation_missing"),
    one(db, "conversations", CONVERSATION_COLUMNS, { id: voiceConversationId }, "voice_conversation_missing"),
    one(db, "conversations", CONVERSATION_COLUMNS, { id: sms.conversation_id }, "sms_conversation_missing"),
    one(db, "billing_usage_events", "business_id,idempotency_key,direction,channel,source,provider_message_id", { idempotency_key: `voice-followup:${action.id}` }, "original_usage_evidence_missing"),
    rows(db.from("voice_actions").select("id").eq("result->>providerMessageId", providerId).limit(2), "provider_identity_lookup_failed"),
    rows(db.from("voice_actions").select("id").eq("sms_provider_message_id", providerId).limit(2), "provider_identity_lookup_failed"),
    rows(db.from("voice_transcript_fragments").select("session_id,business_id,event_id,role,content,start_ms")
      .eq("session_id", entry.sessionId).in("event_id", confirmationIds), "confirmation_evidence_lookup_failed"),
    rows(db.from("goal_events").select(EVENT_COLUMNS).eq("voice_action_id", action.id).limit(2), "goal_event_lookup_failed"),
  ]);
  requireGuard(source.id === action.source_message_id && source.business_id === businessId
    && source.conversation_id === voiceConversationId && source.channel === "voice"
    && source.role === "customer" && typeof source.content === "string" && source.content.length > 0,
  "source_confirmation_mismatch");
  requireGuard(voiceConversation.id === voiceConversationId && voiceConversation.business_id === businessId
    && voiceConversation.channel === "voice" && UUID.test(voiceConversation.contact_id)
    && smsConversation.id === sms.conversation_id && smsConversation.business_id === businessId
    && smsConversation.channel === "sms" && smsConversation.contact_id === voiceConversation.contact_id,
  "conversation_contact_mismatch");
  const contact = await one(db, "contacts", "id,business_id,phone_number", { id: voiceConversation.contact_id }, "contact_missing");
  requireGuard(contact.id === voiceConversation.contact_id && contact.business_id === businessId
    && contact.phone_number === session.caller_phone, "contact_identity_mismatch");
  requireGuard(usage.business_id === businessId && usage.idempotency_key === `voice-followup:${action.id}`
    && usage.direction === "outbound" && usage.channel === "sms"
    && usage.source === "voice_followup_sms" && usage.provider_message_id === providerId,
  "provider_usage_identity_mismatch");
  requireGuard(providerActions.length === 1 && providerActions[0].id === action.id
    && acceptedActions.every((row) => row.id === action.id), "provider_identity_reused");
  requireGuard(fragments.length === confirmationIds.length
    && new Set(fragments.map((fragment) => fragment.event_id)).size === confirmationIds.length
    && fragments.every((fragment) => fragment.session_id === session.id
      && fragment.business_id === businessId && fragment.role === "customer"
      && confirmationIds.includes(fragment.event_id) && typeof fragment.content === "string"
      && Number.isFinite(Number(fragment.start_ms))), "confirmation_evidence_mismatch");
  const confirmedText = [...fragments].sort((left, right) => Number(left.start_ms) - Number(right.start_ms)
    || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0))
    .map((fragment) => fragment.content).join(" ");
  requireGuard(confirmedText === source.content, "confirmation_text_mismatch");

  const hasAcceptance = action.sms_accepted_at !== null && action.sms_accepted_at !== undefined;
  requireGuard(!hasAcceptance || (timestamp(action.sms_accepted_at) !== null
    && action.sms_provider_message_id === providerId), "acceptance_evidence_mismatch");
  requireGuard(hasAcceptance || timestamp(action.sms_logged_at) !== null, "historical_bookkeeping_incomplete");
  const occurredAt = hasAcceptance ? action.sms_accepted_at : sms.created_at;
  const timeSource = hasAcceptance ? "provider_accepted" : "message_recorded";
  const occurred = timestamp(occurredAt);
  requireGuard(occurred !== null && timestamp(sms.created_at) !== null && timestamp(source.created_at) !== null
    && occurred >= timestamp(action.confirmed_at) && occurred >= timestamp(source.created_at)
    && occurred <= timestamp(sms.created_at), "original_timestamp_invalid");
  const snapshot = { action, sms, source, contact, occurredAt, timeSource };
  requireGuard(events.length <= 1 && (!events.length || eventMatches(events[0], snapshot)), "existing_goal_event_mismatch");
  return { ...snapshot, eventId: events[0]?.id ?? null };
}

function publicRow(entry, snapshot, status) {
  return {
    actionId: entry.actionId,
    sessionId: entry.sessionId,
    status,
    occurredAt: snapshot.occurredAt,
    timeSource: snapshot.timeSource,
    ...(snapshot.eventId ? { goalEventId: snapshot.eventId } : {}),
  };
}

function rejectedRow(entry, error) {
  return { actionId: entry.actionId, sessionId: entry.sessionId, status: "rejected",
    reason: error instanceof RestoreGuardError ? error.code : "database_request_failed" };
}

export async function restoreVoiceSignupLeads(db, { apply = false } = {}) {
  const report = {
    mode: apply ? "apply" : "dry-run", businessId: RESTORE_MANIFEST.businessId,
    manifestVersion: RESTORE_MANIFEST.version, providerCalls: 0, usageWrites: 0, rows: [],
  };
  for (const entry of RESTORE_MANIFEST.actions) {
    try {
      const snapshot = await inspectRestoreAction(db, entry);
      report.rows.push(publicRow(entry, snapshot, snapshot.eventId ? "already_present" : "eligible"));
    } catch (error) { report.rows.push(rejectedRow(entry, error)); }
  }
  if (apply && report.rows.every((row) => row.status !== "rejected")) {
    for (let index = 0; index < RESTORE_MANIFEST.actions.length; index += 1) {
      const entry = RESTORE_MANIFEST.actions[index];
      try {
        // Re-read the complete evidence immediately before the RPC. The RPC
        // independently locks/revalidates linkage and handles concurrent runs.
        const snapshot = await inspectRestoreAction(db, entry);
        const { data, error } = await db.rpc("finalize_voice_signup_bookkeeping", {
          p_action_id: entry.actionId,
          p_historical_occurred_at: snapshot.timeSource === "message_recorded" ? snapshot.occurredAt : null,
        });
        requireGuard(!error, "finalization_failed");
        const outcome = Array.isArray(data) && data.length === 1 ? data[0] : null;
        requireGuard(outcome && typeof outcome.created_event === "boolean"
          && UUID.test(outcome.goal_event_id) && outcome.message_id === snapshot.sms.id
          && outcome.conversation_id === snapshot.sms.conversation_id
          && sameTime(outcome.occurred_at, snapshot.occurredAt), "finalization_result_invalid");
        report.rows[index] = publicRow(entry, { ...snapshot, eventId: outcome.goal_event_id },
          outcome.created_event ? "inserted" : "already_present");
      } catch (error) { report.rows[index] = rejectedRow(entry, error); }
    }
  }
  report.counts = Object.fromEntries(["eligible", "inserted", "already_present", "rejected"]
    .map((status) => [status, report.rows.filter((row) => row.status === status).length]));
  report.pass = report.counts.rejected === 0;
  return report;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) { console.log(HELP); return 0; }
  const { url, key } = validateEnvironment(environment);
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init, redirect: "error", signal: AbortSignal.timeout(10000),
    }) },
  });
  const report = await restoreVoiceSignupLeads(db, options);
  console.log(JSON.stringify(report, null, 2));
  return report.pass ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(JSON.stringify({ pass: false, reason:
      error instanceof RestoreGuardError ? error.code : "restore_setup_failed" }));
    process.exitCode = 1;
  });
}
