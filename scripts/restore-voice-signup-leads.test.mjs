import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_MANIFEST,
  inspectRestoreAction,
  parseArguments,
  restoreVoiceSignupLeads,
  validateEnvironment,
} from "./restore-voice-signup-leads.mjs";

const BUSINESS = RESTORE_MANIFEST.businessId;
const OTHER_BUSINESS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const SENT_AT = "2026-09-12T16:20:03.123456+00:00";
const CONFIRMED_AT = "2026-09-12T16:20:00.000001+00:00";
const makeId = (index, suffix) => `0000000${index}-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function fixture() {
  const tables = {
    businesses: [{ id: BUSINESS, owner_id: OWNER, deleted_at: null }],
    voice_actions: [], voice_sessions: [], messages: [], conversations: [],
    contacts: [], billing_usage_events: [], voice_transcript_fragments: [], goal_events: [],
  };
  RESTORE_MANIFEST.actions.forEach((entry, index) => {
    const voice = makeId(index, 1), sms = makeId(index, 2), contact = makeId(index, 3), source = makeId(index, 4);
    const caller = `+1555555010${index}`;
    const providerId = `private-provider-message-${index}`;
    const body = `Private Example: signup https://private.example/signup/${index}`;
    const events = [`confirmed-${index}-a`, `confirmed-${index}-b`];
    tables.voice_actions.push({
      id: entry.actionId, session_id: entry.sessionId, business_id: BUSINESS,
      kind: "signup", status: "succeeded", confirmed_at: CONFIRMED_AT,
      source_message_id: source, confirmation_event_ids: events,
      result: { providerMessageId: providerId, smsBody: body, deliveryStatus: "delivered" },
      sms_provider_message_id: null, sms_accepted_at: null, sms_logged_at: SENT_AT,
      updated_at: "2026-09-17T23:59:59Z", reconciled_at: "2026-09-18T23:59:59Z",
    });
    tables.voice_sessions.push({
      id: entry.sessionId, business_id: BUSINESS, response_mode: "voice", demo_mode: false,
      action_business_id: BUSINESS, conversation_id: voice, action_conversation_id: voice,
      caller_phone: caller, called_phone: "+15555550999",
    });
    tables.messages.push(
      { id: entry.actionId, business_id: BUSINESS, conversation_id: sms, role: "assistant", channel: "sms", content: body, created_at: SENT_AT },
      { id: source, business_id: BUSINESS, conversation_id: voice, role: "customer", channel: "voice", content: "Yes, please text it.", created_at: CONFIRMED_AT },
    );
    tables.conversations.push(
      { id: voice, business_id: BUSINESS, contact_id: contact, channel: "voice" },
      { id: sms, business_id: BUSINESS, contact_id: contact, channel: "sms", status: "closed" },
    );
    tables.contacts.push({ id: contact, business_id: BUSINESS, phone_number: caller });
    tables.billing_usage_events.push({
      business_id: BUSINESS, idempotency_key: `voice-followup:${entry.actionId}`,
      direction: "outbound", channel: "sms", source: "voice_followup_sms", provider_message_id: providerId,
    });
    tables.voice_transcript_fragments.push(
      { session_id: entry.sessionId, business_id: BUSINESS, event_id: events[1], role: "customer", content: "please text it.", start_ms: 1100 },
      { session_id: entry.sessionId, business_id: BUSINESS, event_id: events[0], role: "customer", content: "Yes,", start_ms: 1000 },
    );
  });
  return tables;
}

function addEvent(tables, actionId) {
  const action = tables.voice_actions.find((row) => row.id === actionId);
  const sms = tables.messages.find((row) => row.id === action.id);
  const conversation = tables.conversations.find((row) => row.id === sms.conversation_id);
  const event = {
    id: makeId(8, tables.goal_events.length + 1), business_id: BUSINESS,
    contact_id: conversation.contact_id, conversation_id: sms.conversation_id,
    source_message_id: action.source_message_id, assistant_message_id: sms.id,
    goal_at_event: "signup", event_type: "link_sent", channel: "sms",
    occurred_at: action.sms_accepted_at || sms.created_at,
    idempotency_key: `voice-signup:${action.id}`, voice_action_id: action.id,
    origin_kind: "voice_action", source_conversation_id: tables.messages.find((row) => row.id === action.source_message_id).conversation_id,
    time_source: action.sms_accepted_at ? "provider_accepted" : "message_recorded",
  };
  tables.goal_events.push(event);
  return event;
}

function fakeDatabase(tables = fixture()) {
  const operations = [];
  const readFailures = new Set();
  let beforeRead = () => {};
  const db = {
    from: vi.fn((table) => {
      const filters = [];
      let cap = Infinity, single = false;
      const query = {
        select: () => query,
        eq: (column, value) => { filters.push([column, [value]]); return query; },
        in: (column, values) => { filters.push([column, values]); return query; },
        limit: (value) => { cap = value; return query; },
        maybeSingle: () => { single = true; return query; },
        then: (resolve, reject) => {
          beforeRead({ table, filters, tables });
          operations.push({ type: "select", table, filters });
          if (readFailures.has(table)) return Promise.resolve({ data: null, error: { message: "PII private secret text" } }).then(resolve, reject);
          const matches = (tables[table] || []).filter((row) => filters.every(([column, values]) => {
            const actual = column === "result->>providerMessageId" ? row.result?.providerMessageId : row[column];
            return values.includes(actual);
          })).slice(0, cap);
          return Promise.resolve({ data: structuredClone(single ? matches[0] ?? null : matches), error: single && matches.length > 1 ? { code: "many" } : null }).then(resolve, reject);
        },
      };
      // Deliberately no insert/update/upsert/delete methods: direct writes fail.
      return query;
    }),
    rpc: vi.fn(async (name, arguments_) => {
      operations.push({ type: "rpc", name, arguments_ });
      if (name !== "finalize_voice_signup_bookkeeping") throw new Error("Unexpected write");
      const action = tables.voice_actions.find((row) => row.id === arguments_.p_action_id);
      const existing = tables.goal_events.find((row) => row.voice_action_id === action.id);
      const event = existing || addEvent(tables, action.id);
      return { data: [{ message_id: action.id, conversation_id: event.conversation_id,
        goal_event_id: event.id, occurred_at: event.occurred_at, created_event: !existing }], error: null };
    }),
  };
  return { db, tables, operations, readFailures, setBeforeRead(fn) { beforeRead = fn; } };
}

describe("voice signup history restore boundaries", () => {
  it("contains only the three approved action/session pairs and one business", () => {
    expect(RESTORE_MANIFEST).toEqual({ version: 1, businessId: "ea848911-ef72-44a6-8cf3-c47b3959be26", actions: [
      { actionId: "2ebedbb6-c779-4af9-9f7f-d76ac6583591", sessionId: "dc508f0b-64ef-4bbf-9eb0-4831be1b00b2" },
      { actionId: "3c86f915-4511-4f7f-b29b-6357acc0cd77", sessionId: "367809cc-37f4-4966-af0f-fe8ba3f39f69" },
      { actionId: "4cd65089-7096-49d4-951b-f3de490736d3", sessionId: "cfa3fa6f-b25c-4c60-b982-933dfb0e47f3" },
    ] });
    expect(Object.isFrozen(RESTORE_MANIFEST.actions[0])).toBe(true);
  });

  it("defaults to dry-run and accepts only an explicit bounded mode", () => {
    expect(parseArguments([])).toEqual({ apply: false, help: false });
    expect(parseArguments(["--dry-run"])).toEqual({ apply: false, help: false });
    expect(parseArguments(["--apply"])).toEqual({ apply: true, help: false });
    for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], ["--business-id", OTHER_BUSINESS], ["--manifest", "other.json"], ["--apply=true"]]) {
      expect(() => parseArguments(args)).toThrow();
    }
  });

  it("requires explicit environment credentials without returning them in reports", () => {
    expect(() => validateEnvironment({})).toThrow("missing_supabase_url");
    expect(() => validateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" })).toThrow("missing_service_role_key");
    expect(validateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret" })).toEqual({ url: "https://example.supabase.co", key: "secret" });
    for (const url of ["https://untrusted.example", "http://example.supabase.co", "https://example.supabase.co/path", "https://secret@example.supabase.co"]) {
      expect(() => validateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "secret" })).toThrow("invalid_supabase_url");
    }
  });

  it("rejects an action outside the fixed manifest before any database request", async () => {
    const f = fakeDatabase();
    await expect(inspectRestoreAction(f.db, { actionId: makeId(9, 1), sessionId: makeId(9, 2) })).rejects.toThrow("action_not_in_manifest");
    expect(f.db.from).not.toHaveBeenCalled();
  });

  it("dry-runs all three genuine sends without changing data or calling RPCs", async () => {
    const f = fakeDatabase();
    const original = structuredClone(f.tables);
    const report = await restoreVoiceSignupLeads(f.db);
    expect(report).toMatchObject({ mode: "dry-run", pass: true, providerCalls: 0, usageWrites: 0,
      counts: { eligible: 3, inserted: 0, already_present: 0, rejected: 0 } });
    expect(report.rows.every((row) => row.occurredAt === SENT_AT && row.timeSource === "message_recorded")).toBe(true);
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.tables).toEqual(original);
    expect(JSON.stringify(report)).not.toMatch(/private-provider|1555555|private\.example|please text|secret/);
  });

  it("applies once and safely reports all three as already present on repeat", async () => {
    const f = fakeDatabase();
    const smsBefore = structuredClone(f.tables.messages);
    const usageBefore = structuredClone(f.tables.billing_usage_events);
    const first = await restoreVoiceSignupLeads(f.db, { apply: true });
    const second = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(first.counts).toEqual({ eligible: 0, inserted: 3, already_present: 0, rejected: 0 });
    expect(second.counts).toEqual({ eligible: 0, inserted: 0, already_present: 3, rejected: 0 });
    expect(f.tables.goal_events).toHaveLength(3);
    expect(f.tables.messages).toEqual(smsBefore);
    expect(f.tables.billing_usage_events).toEqual(usageBefore);
    expect(f.db.rpc.mock.calls).toEqual([...RESTORE_MANIFEST.actions, ...RESTORE_MANIFEST.actions].map((entry) => [
      "finalize_voice_signup_bookkeeping", { p_action_id: entry.actionId, p_historical_occurred_at: SENT_AT },
    ]));
    expect(f.operations.filter((operation) => operation.type !== "select").every((operation) => operation.name === "finalize_voice_signup_bookkeeping")).toBe(true);
  });

  it("uses stored acceptance time before original SMS time and ignores recovery update times", async () => {
    const f = fakeDatabase();
    const action = f.tables.voice_actions[0];
    action.sms_accepted_at = "2026-09-12T16:20:01.456789+00:00";
    action.sms_provider_message_id = action.result.providerMessageId;
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.rows[0]).toMatchObject({ status: "inserted", occurredAt: action.sms_accepted_at, timeSource: "provider_accepted" });
    expect(f.db.rpc.mock.calls[0][1].p_historical_occurred_at).toBeNull();
    expect(f.tables.goal_events[0].occurred_at).toBe(action.sms_accepted_at);
  });

  it("uses the original closed SMS thread even when another thread is now open", async () => {
    const f = fakeDatabase();
    f.tables.conversations.push({ ...f.tables.conversations[1], id: makeId(7, 1), status: "active" });
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.pass).toBe(true);
    expect(f.tables.goal_events[0].conversation_id).toBe(f.tables.messages[0].conversation_id);
  });
});

describe("historical send eligibility guards", () => {
  it.each([
    ["missing SMS", (f) => { f.messages.shift(); }, "original_sms_missing"],
    ["another business", (f) => { f.voice_actions[0].business_id = OTHER_BUSINESS; }, "action_scope_mismatch"],
    ["another session", (f) => { f.voice_actions[0].session_id = makeId(7, 1); }, "action_scope_mismatch"],
    ["deleted business", (f) => { f.businesses[0].deleted_at = SENT_AT; }, "business_not_retained"],
    ["scrubbed business", (f) => { f.businesses[0].cleanup_pii_scrubbed_at = SENT_AT; }, "business_not_retained"],
    ["demo session", (f) => { f.voice_sessions[0].demo_mode = true; }, "session_scope_mismatch"],
    ["rerouted action tenant", (f) => { f.voice_sessions[0].action_business_id = OTHER_BUSINESS; }, "session_scope_mismatch"],
    ["unconfirmed", (f) => { f.voice_actions[0].confirmed_at = null; }, "action_not_confirmed_successful_signup"],
    ["uncertain", (f) => { f.voice_actions[0].status = "uncertain"; }, "action_not_confirmed_successful_signup"],
    ["different kind", (f) => { f.voice_actions[0].kind = "contact"; }, "action_not_confirmed_successful_signup"],
    ["not delivered", (f) => { f.voice_actions[0].result.deliveryStatus = "accepted"; }, "verified_delivery_missing"],
    ["missing provider", (f) => { f.voice_actions[0].result.providerMessageId = null; }, "verified_delivery_missing"],
    ["changed provider", (f) => { f.voice_actions[0].sms_provider_message_id = "different"; }, "provider_identity_mismatch"],
    ["changed SMS body", (f) => { f.messages[0].content = "different"; }, "original_sms_mismatch"],
    ["different source role", (f) => { f.messages[1].role = "assistant"; }, "source_confirmation_mismatch"],
    ["different source business", (f) => { f.messages[1].business_id = OTHER_BUSINESS; }, "source_confirmation_mismatch"],
    ["different source thread", (f) => { f.messages[1].conversation_id = makeId(7, 1); }, "source_confirmation_mismatch"],
    ["different SMS contact", (f) => { f.conversations[1].contact_id = makeId(7, 1); }, "conversation_contact_mismatch"],
    ["different contact tenant", (f) => { f.contacts[0].business_id = OTHER_BUSINESS; }, "contact_identity_mismatch"],
    ["different caller", (f) => { f.contacts[0].phone_number = "+15555550000"; }, "contact_identity_mismatch"],
    ["different billed provider", (f) => { f.billing_usage_events[0].provider_message_id = "different"; }, "provider_usage_identity_mismatch"],
    ["different billed tenant", (f) => { f.billing_usage_events[0].business_id = OTHER_BUSINESS; }, "provider_usage_identity_mismatch"],
    ["missing usage", (f) => { f.billing_usage_events.shift(); }, "original_usage_evidence_missing"],
    ["reused provider", (f) => { f.voice_actions.push({ ...f.voice_actions[0], id: makeId(7, 1) }); }, "provider_identity_reused"],
    ["other accepted provider", (f) => { f.voice_actions[1].sms_provider_message_id = f.voice_actions[0].result.providerMessageId; }, "provider_identity_reused"],
    ["missing confirmation fragment", (f) => { f.voice_transcript_fragments.shift(); }, "confirmation_evidence_mismatch"],
    ["different confirmation content", (f) => { f.voice_transcript_fragments[0].content = "No, do not send"; }, "confirmation_text_mismatch"],
    ["missing original time", (f) => { f.messages[0].created_at = null; }, "original_timestamp_invalid"],
    ["incomplete historical bookkeeping", (f) => { f.voice_actions[0].sms_logged_at = null; }, "historical_bookkeeping_incomplete"],
    ["time before permission", (f) => { f.messages[0].created_at = "2026-09-11T00:00:00Z"; }, "original_timestamp_invalid"],
    ["acceptance without identity", (f) => { f.voice_actions[0].sms_accepted_at = SENT_AT; }, "acceptance_evidence_mismatch"],
  ])("rejects %s and prevents all apply writes", async (_name, alter, reason) => {
    const f = fakeDatabase();
    alter(f.tables);
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({ status: "rejected", reason });
    expect(f.db.rpc).not.toHaveBeenCalled();
  });

  it("accepts a matching prior event but rejects a one-microsecond event collision", async () => {
    const f = fakeDatabase();
    const event = addEvent(f.tables, RESTORE_MANIFEST.actions[0].actionId);
    let report = await restoreVoiceSignupLeads(f.db);
    expect(report.rows[0].status).toBe("already_present");
    event.occurred_at = "2026-09-12T16:20:03.123457Z";
    report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.rows[0]).toMatchObject({ status: "rejected", reason: "existing_goal_event_mismatch" });
    expect(f.db.rpc).not.toHaveBeenCalled();
  });

  it.each(["origin_kind", "source_conversation_id"])("rejects mismatched event %s", async (field) => {
    const f = fakeDatabase();
    const event = addEvent(f.tables, RESTORE_MANIFEST.actions[0].actionId);
    event[field] = field === "origin_kind" ? "conversation" : makeId(7, 1);
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.rows[0]).toMatchObject({ status: "rejected", reason: "existing_goal_event_mismatch" });
    expect(f.db.rpc).not.toHaveBeenCalled();
  });

  it("rechecks evidence immediately before applying and rejects changed evidence", async () => {
    const f = fakeDatabase();
    let actionReads = 0;
    f.setBeforeRead(({ table, filters }) => {
      if (table === "voice_actions" && filters.some(([column, values]) => column === "id" && values[0] === RESTORE_MANIFEST.actions[0].actionId)) {
        actionReads += 1;
        if (actionReads === 2) f.tables.voice_actions[0].result.deliveryStatus = "delivery_failed";
      }
    });
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.rows[0]).toMatchObject({ status: "rejected", reason: "verified_delivery_missing" });
    expect(f.db.rpc.mock.calls.some(([, args]) => args.p_action_id === RESTORE_MANIFEST.actions[0].actionId)).toBe(false);
  });

  it("reports sanitized database and RPC failures without printing their messages", async () => {
    const f = fakeDatabase();
    f.readFailures.add("billing_usage_events");
    let report = await restoreVoiceSignupLeads(f.db);
    expect(report.counts.rejected).toBe(3);
    expect(JSON.stringify(report)).not.toMatch(/PII|private|secret/);
    f.readFailures.clear();
    f.db.rpc.mockResolvedValue({ data: null, error: { message: "private@example.com +15555550100 provider-secret" } });
    report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.counts.rejected).toBe(3);
    expect(report.rows.every((row) => row.reason === "finalization_failed")).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/private|1555555|provider-secret/);
  });

  it("rejects an unexpected finalizer result instead of claiming restoration", async () => {
    const f = fakeDatabase();
    f.db.rpc.mockResolvedValue({ data: [{ created_event: true, message_id: makeId(7, 1) }], error: null });
    const report = await restoreVoiceSignupLeads(f.db, { apply: true });
    expect(report.counts.rejected).toBe(3);
    expect(report.rows.every((row) => row.reason === "finalization_result_invalid")).toBe(true);
  });

  it("has no provider/send/rebilling or direct table-write capability", async () => {
    const source = await readFile(new URL("./restore-voice-signup-leads.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["'](?:telnyx|stripe)|messages\.send|recordOutboundSmsUsage|record_billing_usage_event|\.(?:insert|update|upsert|delete)\(/);
    const rpcNames = [...source.matchAll(/db\.rpc\("([^"]+)"/g)].map((match) => match[1]);
    expect(rpcNames).toEqual(["finalize_voice_signup_bookkeeping"]);
  });
});
