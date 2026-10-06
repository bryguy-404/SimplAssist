import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminUser } from "@/lib/admin/auth";
import { adminMutationJson, authorizeAdminMutation, readAdminMutationJson } from "@/lib/admin/adminMutation.server";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { inspectReviewCampaignRetry, prepareReviewCampaignRetry, reauthorizeReviewCampaignRetry, executeReviewCampaignRetry } from "@/lib/reviews/campaignRetry.server";
import { serializeCampaignError, logCampaignError } from "@/lib/reviews/campaignDiagnostics.server";

export const maxDuration = 60;
const businessId = z.string().uuid();
const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), businessId, ownerId: z.string().uuid(), accountId: z.string().uuid(),
    originalReservationId: z.string().uuid(), originalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    membershipRevision: z.number().int().positive(), acceptAdditionalFee: z.literal(true) }).strict(),
  z.object({ action: z.literal("reauthorize"), businessId, ownerId: z.string().uuid(), accountId: z.string().uuid(),
    originalReservationId: z.string().uuid(), originalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    membershipRevision: z.number().int().positive(), acceptAdditionalFee: z.literal(true),
    attemptId: z.string().uuid(), authorizationRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("execute"), businessId, attemptId: z.string().uuid(), token: z.string().uuid() }).strict(),
]);
function failure(error: unknown, id: string) {
  const known = error instanceof ReviewSmsError;
  // The submission helper already captured private-value-redacted diagnostics.
  // Never serialize an unknown provider exception again without that context.
  logCampaignError({ businessId: id, phase: "admin_retry_control", error: serializeCampaignError(
    new Error(known ? error.code : "review_sms_campaign_retry_unavailable"),
  ) });
  return adminMutationJson({ error: "The campaign outcome needs inspection. No automatic additional submission will be made.",
    code: known ? error.code : "review_sms_campaign_retry_unavailable" }, { status: known ? error.status : 503 });
}
export async function GET(request: NextRequest) {
  if (!await getAdminUser()) return adminMutationJson({ error: "Not found" }, { status: 404 });
  const parsed = businessId.safeParse(request.nextUrl.searchParams.get("businessId"));
  if (!parsed.success) return adminMutationJson({ error: "Invalid account" }, { status: 400 });
  try { return adminMutationJson({ inspection: await inspectReviewCampaignRetry(parsed.data) }); }
  catch (error) { return failure(error, parsed.data); }
}
export async function POST(request: NextRequest) {
  const authorized = await authorizeAdminMutation(request);
  if ("response" in authorized) return authorized.response;
  const body = await readAdminMutationJson(request);
  if (!body.ok) return body.response;
  const parsed = actions.safeParse(body.value);
  if (!parsed.success) return adminMutationJson({ error: "Invalid retry request" }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "prepare") return adminMutationJson({ authorization: await prepareReviewCampaignRetry({ ...input, actorId: authorized.admin.id }) });
    if (input.action === "reauthorize") return adminMutationJson({ authorization: await reauthorizeReviewCampaignRetry({ ...input, actorId: authorized.admin.id }) });
    return adminMutationJson({ inspection: await executeReviewCampaignRetry(input) });
  } catch (error) { return failure(error, parsed.data.businessId); }
}
