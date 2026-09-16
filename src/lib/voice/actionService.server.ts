import { persistVoiceSmsBookkeeping } from "./actionRecovery.server";
import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import {
  voiceActionPayload,
  actionFingerprint,
  buildActionReadback,
  type ActionDecision,
  type VoiceAction,
  type VoiceAnswer,
} from "./actions";
import type { VoiceSession } from "./types";
import { checkAvailability, createBooking } from "@/lib/google/calendar";
import { recordBookingRequest } from "@/lib/ai/bookingRequests";
import { getOutboundSendContext } from "@/lib/messaging/lookup";
import { preflightOutboundSms } from "@/lib/billing/usage";
import { resolveOutboundSmsOperationalAccess } from "@/lib/messaging/outboundSmsOperational.server";
import { telnyx } from "@/lib/messaging/client";
import { normalizeHttpsGoalUrl } from "@/lib/goals/primaryGoal";

export async function loadVoiceActionContext(sessionId: string) {
  const { data: session, error } = await db
    .from("voice_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (
    error ||
    !session ||
    session.status !== "active" ||
    session.response_mode !== "voice"
  )
    throw new Error("voice_call_not_active");
  const s = session as VoiceSession;
  if (s.demo_mode && !s.action_business_id)
    throw new Error("voice_demo_unavailable");
  const businessId = s.action_business_id || s.business_id;
  const [
    { data: b, error: be },
    { data: settings, error: se },
    { data: actions, error: ae },
    ...permissions
  ] = await Promise.all([
    db
      .from("businesses")
      .select("name,timezone,primary_goal,goal_url")
      .eq("id", businessId)
      .single(),
    db
      .from("ai_settings")
      .select("booking_enabled,booking_mode")
      .eq("business_id", businessId)
      .single(),
    db
      .from("voice_actions")
      .select("*")
      .eq("session_id", s.id)
      .order("revision"),
    ...["contact", "booking", "signup"].map((kind) =>
      db.rpc("voice_action_allowed", { p_session_id: s.id, p_kind: kind }),
    ),
  ]);
  if (be || se || ae || permissions.some((r) => r.error) || !b || !settings)
    throw new Error("voice_action_context_unavailable");
  return {
    session: s,
    business: b,
    settings,
    actions: actions as VoiceAction[],
    capabilities: {
      contacts: !!permissions[0].data,
      booking:
        !!permissions[1].data &&
        settings.booking_enabled &&
        b.primary_goal === "book",
      signup: !!permissions[2].data && b.primary_goal === "signup",
    },
  };
}
function assertCapability(
  ctx: Awaited<ReturnType<typeof loadVoiceActionContext>>,
  kind: string,
) {
  const c = ctx.capabilities;
  if (
    !(kind === "contact"
      ? c.contacts
      : kind === "signup"
        ? c.signup
        : c.booking)
  )
    throw new Error("voice_action_disabled");
  if (kind === "booking" && ctx.settings.booking_mode !== "schedule_direct")
    throw new Error("voice_direct_booking_disabled");
  if (
    kind === "booking_request" &&
    ctx.settings.booking_mode !== "collect_info"
  )
    throw new Error("voice_booking_request_disabled");
}

async function completedActionAnswer(
  sessionId: string,
  action: VoiceAction,
  summary: string,
): Promise<VoiceAnswer> {
  if (action.kind !== "contact" || action.status !== "succeeded")
    return { text: summary };
  // Saving contact details and preparing the next permission question are
  // separate outcomes. The saved contact remains successful if this optional
  // continuation becomes unavailable, and preparation never grants SMS consent.
  try {
    const fresh = await loadVoiceActionContext(sessionId);
    if (!fresh.capabilities.signup || fresh.business.primary_goal !== "signup")
      return { text: summary };
    const url = normalizeHttpsGoalUrl(fresh.business.goal_url);
    if (!url) return { text: summary };
    const payload = { kind: "signup" as const };
    const { data: next, error } = await db.rpc(
      "prepare_voice_signup_after_contact",
      {
        p_session_id: sessionId,
        p_contact_action_id: action.id,
        p_fingerprint: actionFingerprint(payload, url),
        p_payload: { ...payload, approvedUrl: url },
        p_readback: buildActionReadback(
          payload,
          fresh.session.caller_phone,
          fresh.business.timezone,
        ),
      },
    );
    if (error) throw new Error("voice_signup_continuation_failed");
    // PostgREST represents a NULL composite as an object of null fields.
    if (!next?.id) return { text: summary };
    if (
      next.session_id !== sessionId ||
      next.kind !== "signup" ||
      next.status !== "awaiting_confirmation"
    )
      throw new Error("voice_signup_continuation_failed");
    return {
      text: `${summary} If the caller has declined signup or is finished, acknowledge that and do not repeat the offer. Otherwise continue now with this prepared permission question, preserving every detail: ${next.readback} Wait for a fresh clear reply. Nothing has been sent yet; permission to save details does not authorize a text.`,
      confirmationActionId: next.id,
    };
  } catch {
    console.warn("[voice-actions] signup_continuation_unavailable", {
      sessionId,
      actionId: action.id,
      category: "preparation_failed",
    });
    return { text: summary };
  }
}

async function saveConfirmedContact(a: VoiceAction) {
  const { data, error } = await db.rpc("save_voice_action_contact", {
    p_action_id: a.id,
  });
  if (error || !data?.contactId || !data.conversationId)
    throw new Error("voice_contact_save_failed");
  return data as {
    contactId: string;
    conversationId: string;
    conflicts: string[];
  };
}
export async function runVoiceDecision(
  sessionId: string,
  decision: ActionDecision,
): Promise<VoiceAnswer> {
  const ctx = await loadVoiceActionContext(sessionId);
  if (decision.intent === "answer") return { text: decision.text };
  if (decision.intent === "availability") {
    assertCapability(ctx, "booking");
    const slots = await checkAvailability(
      ctx.session.action_business_id || ctx.session.business_id,
      decision.date,
      ctx.business.timezone,
      { sessionId },
    );
    const saved = await db.from("voice_availability").upsert({
      session_id: sessionId,
      date: decision.date,
      slots,
      checked_at: new Date().toISOString(),
    });
    if (saved.error) throw new Error("voice_availability_save_failed");
    return {
      text: `Available on ${decision.date} in ${ctx.business.timezone}: ${slots.join(", ") || "none"}. No appointment has been booked. Offer up to two appropriate slots and ask which the caller prefers.`,
    };
  }
  if (decision.intent === "propose") {
    const payload = voiceActionPayload.parse(decision.payload);
    assertCapability(ctx, payload.kind);
    if ("email" in payload && payload.email)
      payload.email = payload.email.toLowerCase();
    if ("phone" in payload && payload.phone !== ctx.session.caller_phone)
      throw new Error("voice_phone_must_match_caller");
    if (payload.kind === "booking") {
      const date = payload.startTime.slice(0, 10),
        hour = Number(payload.startTime.slice(11, 13)),
        minute = payload.startTime.slice(14, 16);
      const label = `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
      const { data: offered, error: av } = await db
        .from("voice_availability")
        .select("slots,checked_at")
        .eq("session_id", sessionId)
        .eq("date", date)
        .single();
      if (
        av ||
        !offered ||
        Date.now() - Date.parse(offered.checked_at) > 300000 ||
        !offered.slots.includes(label)
      )
        return {
          text: "Check current availability and offer a returned slot before preparing a booking.",
        };
    }
    const url =
      payload.kind === "signup"
        ? normalizeHttpsGoalUrl(ctx.business.goal_url)
        : undefined;
    if (payload.kind === "signup" && !url)
      throw new Error("voice_signup_link_missing");
    const readback = buildActionReadback(
      payload,
      ctx.session.caller_phone,
      ctx.business.timezone,
    );
    const { data: a, error } = await db.rpc("propose_voice_action", {
      p_session_id: sessionId,
      p_kind: payload.kind,
      p_fingerprint: actionFingerprint(payload, url || undefined),
      p_payload: { ...payload, ...(url ? { approvedUrl: url } : {}) },
      p_readback: readback,
      p_event_ids: decision.requestEventIds,
    });
    if (error || !a) {
      const reasons = [
        "request transcript evidence missing",
        "previous action unresolved",
        "voice action disabled",
        "appointment already captured",
      ];
      console.warn("[voice-actions] proposal_rejected", {
        sessionId,
        category:
          error && reasons.includes(error.message)
            ? error.message
            : "database_unavailable",
      });
      throw new Error("voice_proposal_failed");
    }
    if (a.status !== "awaiting_confirmation")
      return completedActionAnswer(
        sessionId,
        a,
        a.result?.summary ||
          "This request was already attempted. Do not repeat it or claim a new success.",
      );
    return {
      text: `Ask this confirmation naturally, preserving every detail: ${readback} Wait for a clear yes. Nothing has been saved, booked, or sent yet.`,
      confirmationActionId: a.id,
    };
  }
  const a = ctx.actions.find((x) => x.id === decision.actionId);
  if (!a) throw new Error("voice_action_missing");
  assertCapability(ctx, a.kind);
  if (a.status !== "awaiting_confirmation")
    return completedActionAnswer(
      sessionId,
      a,
      a.result?.summary ||
        "This request is already being checked. Do not submit it again or claim success.",
    );
  if (decision.intent === "readback")
    return {
      text: `Ask this stored confirmation naturally, preserving every detail: ${a.readback} Wait for a fresh clear reply before delegating confirmation. Nothing has been saved, booked, or sent by this pending action.`,
      confirmationActionId: a.id,
    };
  if (!a.playback_at || !Number.isSafeInteger(a.playback_caller_end_ms))
    return {
      text: `The current permission question has not been acknowledged as played. Ask it again and wait for the caller: ${a.readback}`,
      confirmationActionId: a.id,
    };
  // intent=confirm is the answering model's semantic classification of the
  // complete reply, not a phrase match. Enforce its evidence independently:
  // a selected "yes" must not omit conditions/corrections from that reply.
  const { data: evidence, error: ee } = await db
    .from("voice_transcript_fragments")
    .select("event_id")
    .eq("session_id", sessionId)
    .eq("role", "customer")
    .gt("received_at", a.playback_at)
    .gte("start_ms", a.playback_caller_end_ms!);
  const cited = new Set(decision.confirmationEventIds);
  if (
    ee ||
    !evidence?.length ||
    evidence.length !== cited.size ||
    decision.confirmationEventIds.length !== cited.size ||
    evidence.some((f) => !cited.has(f.event_id))
  ) {
    console.warn("[voice-actions] confirmation_rejected", {
      sessionId,
      category: ee
        ? "evidence_unavailable"
        : "confirmation_evidence_incomplete",
    });
    return {
      text: `The cited reply does not cover the complete current caller response. Do not act on selected words or earlier permission. Clarify any correction; otherwise ask the current permission question again: ${a.readback}`,
      confirmationActionId: a.id,
    };
  }
  const { data: claimed, error } = await db.rpc("claim_voice_action", {
    p_session_id: sessionId,
    p_action_id: a.id,
    p_readback_ids: decision.readbackEventIds,
    p_confirmation_ids: decision.confirmationEventIds,
  });
  if (error || !claimed) {
    const reasons = [
      "voice action not confirmable",
      "readback evidence missing",
      "confirmation evidence out of order",
      "confirmation evidence incomplete",
      "confirmation superseded",
    ];
    console.warn("[voice-actions] confirmation_rejected", {
      sessionId,
      category:
        error && reasons.includes(error.message)
          ? error.message
          : "confirmation_unavailable",
    });
    return {
      text: `Please read the pending details back and ask for a clear confirmation again. No action was submitted. ${a.readback}`,
      confirmationActionId: a.id,
    };
  }
  // Only the request that changed the row may execute it. Claim tokens below
  // provide ownership independent of a repeated HTTP request/delegation.
  return executeVoiceAction(ctx, claimed);
}
async function assertCurrentAction(id: string) {
  const { data, error } = await db.rpc("voice_action_execution_current", {
    p_action_id: id,
  });
  if (error || !data) throw new Error("voice_confirmation_superseded");
}
async function executeVoiceAction(
  ctx: Awaited<ReturnType<typeof loadVoiceActionContext>>,
  a: VoiceAction,
): Promise<VoiceAnswer> {
  const { data: owned, error: oe } = await db
    .from("voice_actions")
    .update({ execution_started_at: new Date().toISOString() })
    .eq("id", a.id)
    .eq("status", "executing")
    .is("execution_started_at", null)
    .select("id");
  if (oe) throw new Error("voice_execution_claim_failed");
  if (!owned?.length)
    return {
      text: "This request has already been submitted. Its result is being checked; do not repeat it.",
    };
  let submitted = false;
  try {
    const fresh = await loadVoiceActionContext(ctx.session.id);
    assertCapability(fresh, a.kind);
    const raw = a.payload as unknown as Record<string, unknown>;
    const body = { ...raw };
    delete body.approvedUrl;
    const payload = voiceActionPayload.parse(body);
    await assertCurrentAction(a.id);
    const link = await saveConfirmedContact({ ...a, payload });
    let result: Record<string, unknown> & { summary: string };
    if (payload.kind === "contact")
      result = {
        summary:
          "The caller's confirmed contact details were saved with this call.",
        contactId: link.contactId,
        conflicts: link.conflicts,
      };
    else if (payload.kind === "booking_request") {
      await recordBookingRequest({
        businessId: a.business_id,
        contactId: link.contactId,
        conversationId: link.conversationId,
        sourceMessageId: a.source_message_id!,
        requestedService: payload.service,
        requestedTimeText: payload.requestedTime,
        customerName: payload.name,
        customerPhone: payload.phone,
        customerEmail: payload.email,
      });
      result = {
        summary:
          "The appointment request was saved for owner review. It is not a confirmed appointment.",
        conflicts: link.conflicts,
      };
    } else if (payload.kind === "booking") {
      await assertCurrentAction(a.id);
      submitted = true;
      const booking = await createBooking(
        a.business_id,
        {
          customerName: payload.name,
          customerPhone: payload.phone,
          customerEmail: payload.email,
          serviceName: payload.service,
          startTime: payload.startTime,
        },
        ctx.business.timezone,
        {
          contactId: link.contactId,
          conversationId: link.conversationId,
          sourceMessageId: a.source_message_id!,
        },
        { sessionId: ctx.session.id, actionId: a.id },
      );
      result = {
        ...booking,
        summary: `The appointment is confirmed: ${payload.service}, ${payload.startTime.replace("T", " at ")} in ${ctx.business.timezone}.`,
        conflicts: link.conflicts,
      };
    } else {
      const url = normalizeHttpsGoalUrl(fresh.business.goal_url);
      if (!url || url !== raw.approvedUrl || ctx.session.demo_mode)
        throw new Error("voice_signup_link_changed");
      const send = await getOutboundSendContext(ctx.session.called_phone);
      if (
        !send.smsReady ||
        send.businessId !== a.business_id ||
        !send.messagingProfileId
      )
        throw new Error("voice_sms_unavailable");
      let inspected = 0;
      for await (const optout of telnyx.messagingOptouts.list(
        {
          filter: { messaging_profile_id: send.messagingProfileId },
          redaction_enabled: "false",
        },
        { maxRetries: 0, timeout: 5000 },
      )) {
        if (++inspected > 10000)
          throw new Error("voice_sms_optout_check_incomplete");
        if (optout.to === ctx.session.caller_phone)
          throw new Error("voice_sms_opted_out");
      }
      const sms = `${fresh.business.name}: Here's the signup link you requested on our call: ${url}\nReply STOP to opt out.`;
      const preflight = await preflightOutboundSms({
        businessId: a.business_id,
        text: sms,
        purpose: "voice_followup",
      });
      const operational = await resolveOutboundSmsOperationalAccess(
        a.business_id,
        "voice_followup",
      );
      if (!preflight.allowed || !operational.allowed)
        throw new Error("voice_sms_blocked");
      await assertCurrentAction(a.id);
      submitted = true;
      const response = await telnyx.messages.send(
        {
          from: ctx.session.called_phone,
          to: ctx.session.caller_phone,
          text: sms,
          messaging_profile_id: send.messagingProfileId,
          type: "SMS",
        },
        { maxRetries: 0 },
      );
      if (!response.data?.id) throw new Error("voice_sms_result_uncertain");
      result = {
        summary:
          "The signup text was accepted for sending to the number calling in. Delivery is not yet confirmed, and signup has not been completed.",
        providerMessageId: response.data.id,
        deliveryStatus: "accepted",
        smsBody: sms,
      };
      // Persist provider acceptance before any optional bookkeeping can fail.
      const saved = await db
        .from("voice_actions")
        .update({
          result,
          status: "succeeded",
          updated_at: new Date().toISOString(),
        })
        .eq("id", a.id);
      if (saved.error) throw new Error("voice_sms_result_save_failed");
      await persistVoiceSmsBookkeeping(a, result);
    }
    const { error } = await db
      .from("voice_actions")
      .update({
        status: "succeeded",
        result,
        recovery_complete: payload.kind !== "signup",
        updated_at: new Date().toISOString(),
      })
      .eq("id", a.id)
      .eq("status", "executing");
    if (error) throw new Error("voice_result_save_failed");
    return await completedActionAnswer(
      ctx.session.id,
      { ...a, status: "succeeded", result },
      result.summary,
    );
  } catch (failure) {
    const { data: completed } = await db
      .from("voice_actions")
      .select("status,result")
      .eq("id", a.id)
      .maybeSingle();
    if (completed?.status === "succeeded" && completed.result?.summary)
      return completedActionAnswer(
        ctx.session.id,
        { ...a, status: "succeeded", result: completed.result },
        completed.result.summary,
      );
    const status = (failure as { status?: number })?.status;
    if (status && [400, 401, 403, 404, 422].includes(status)) submitted = false;
    await db
      .from("voice_actions")
      .update({
        status: submitted ? "uncertain" : "failed",
        error_code: submitted
          ? "provider_result_needs_review"
          : "action_not_completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", a.id)
      .eq("status", "executing");
    return {
      text: submitted
        ? "I couldn't verify the final result. Do not claim completion or submit it again. The result needs to be checked."
        : "The action could not be completed. Explain this plainly; do not claim it was saved, sent, or booked.",
    };
  }
}
