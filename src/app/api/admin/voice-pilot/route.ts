import { NextRequest } from "next/server";
import { z } from "zod";
import {
  authorizeAdminMutation,
  adminMutationJson,
  readAdminMutationJson,
} from "@/lib/admin/adminMutation.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pilotRoutingDependencies } from "@/lib/voice/routing.server";
import { PILOT_BUSINESS_ID } from "@/lib/voice/types";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settings"),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    budgetMinutes: z.number().int().min(0).max(6000),
    testers: z
      .array(
        z.object({
          phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
          label: z.string().max(100),
        }),
      )
      .max(50),
  }),
  z.object({ action: z.literal("stop") }),
  z.object({
    action: z.literal("feedback"),
    sessionId: z.string().uuid(),
    feedback: z.string().max(4000),
  }),
  z.object({
    action: z.literal("reconcile"),
    sessionId: z.string().uuid(),
    seconds: z.number().finite().min(0).max(86400),
    reference: z.string().trim().min(10).max(1000),
  }),
]);
export async function POST(request: NextRequest) {
  const auth = await authorizeAdminMutation(request);
  if ("response" in auth) return auth.response;
  const json = await readAdminMutationJson(request);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.value);
  if (!parsed.success)
    return adminMutationJson(
      { error: "Check the submitted pilot settings." },
      { status: 400 },
    );
  const input = parsed.data;
  if (input.action === "settings" && input.enabled) {
    if (
      process.env.VOICE_PILOT_ROLLOUT !== "true" ||
      !(await pilotRoutingDependencies().workerReady())
    )
      return adminMutationJson(
        {
          error: "Voice deployment checks must pass before enabling the pilot.",
        },
        { status: 409 },
      );
  }
  let result;
  if (input.action === "settings") {
    if (
      new Set(input.testers.map((t) => t.phone)).size !== input.testers.length
    )
      return adminMutationJson(
        { error: "Each tester number must be unique." },
        { status: 400 },
      );
    result = await supabaseAdmin.rpc("configure_voice_pilot", {
      p_revision: input.revision,
      p_enabled: input.enabled,
      p_budget_seconds: input.budgetMinutes * 60,
      p_testers: input.testers,
      p_admin: auth.admin.id,
    });
  } else if (input.action === "stop") {
    result = await supabaseAdmin.rpc("stop_voice_pilot", {
      p_admin: auth.admin.id,
    });
  } else if (input.action === "reconcile") {
    result = await supabaseAdmin.rpc("reconcile_voice_usage", {
      p_session_id: input.sessionId,
      p_seconds: input.seconds,
      p_reference: input.reference,
      p_admin: auth.admin.id,
    });
  } else {
    result = await supabaseAdmin
      .from("voice_sessions")
      .update({ feedback: input.feedback })
      .eq("id", input.sessionId)
      .eq("business_id", PILOT_BUSINESS_ID)
      .select("id");
    if (!result.error && !result.data?.length)
      return adminMutationJson({ error: "Call not found." }, { status: 404 });
  }
  if (result.error)
    return adminMutationJson(
      {
        error:
          result.error.code === "40001"
            ? "Settings changed. Reload and try again."
            : "Could not save. Check the budget, tester numbers, and current call state.",
      },
      { status: 409 },
    );
  return adminMutationJson({ ok: true });
}
