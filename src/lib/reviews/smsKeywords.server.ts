import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { telnyx } from "@/lib/messaging/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ReviewSmsError } from "@/lib/billing/reviewSms";

type Operation = "start" | "stop" | "info";
type Rule = {
  country_code: string;
  op: Operation;
  keywords: string[];
  resp_text: string;
};
type ProviderRule = Rule & { id: string };
export type ReviewSmsKeywordProgram = Record<Operation, Rule>;
const operations: Operation[] = ["stop", "start", "info"];
const requestOptions = { maxRetries: 0, timeout: 10000 };
const keyword = (value: string) =>
  value.trim().replace(/\s+/g, " ").toUpperCase();
const requiredKeywords: Record<Operation, string[]> = {
  stop: ["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  start: ["START", "UNSTOP"],
  info: ["HELP", "INFO"],
};

export function reviewSmsKeywordProgram(
  businessName: string,
  supportEmail: string,
): ReviewSmsKeywordProgram {
  const name = businessName
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 70);
  if (!name || !z.string().email().safeParse(supportEmail).success)
    throw new ReviewSmsError("review_sms_keyword_copy_invalid");
  return {
    stop: {
      country_code: "*",
      op: "stop",
      keywords: [...requiredKeywords.stop, "REVOKE", "OPT OUT"],
      resp_text: `${name}: You have been unsubscribed. No further messages will be sent.`,
    },
    start: {
      country_code: "*",
      op: "start",
      keywords: [...requiredKeywords.start],
      resp_text: `${name}: You opted in to review requests. Up to 2 messages per service. Msg & data rates may apply. Consent is not a condition of purchase. Reply HELP for help or STOP to opt out.`,
    },
    info: {
      country_code: "*",
      op: "info",
      keywords: [...requiredKeywords.info],
      resp_text: `${name}: For help contact ${supportEmail}. Reply STOP to opt out.`,
    },
  };
}

/** Use the actual approved copy for an existing/MIXED campaign. Never replace
 * a shared customer-care response with a review-only response implicitly. */
export function keywordProgramFromCampaign(campaign: {
  optinKeywords?: string | null;
  optinMessage?: string | null;
  optoutKeywords?: string | null;
  optoutMessage?: string | null;
  helpKeywords?: string | null;
  helpMessage?: string | null;
}): ReviewSmsKeywordProgram {
  const declarations = {
    start: [campaign.optinKeywords, campaign.optinMessage],
    stop: [campaign.optoutKeywords, campaign.optoutMessage],
    info: [campaign.helpKeywords, campaign.helpMessage],
  };
  return Object.fromEntries(
    operations.map((op) => {
      const [words, text] = declarations[op];
      if (!words?.trim() || !text?.trim())
        throw new ReviewSmsError("review_sms_campaign_keywords_missing");
      const keywords = Array.from(
        new Set([
          ...requiredKeywords[op],
          ...words.split(",").map(keyword).filter(Boolean),
        ]),
      );
      const supported =
        op === "stop"
          ? [...requiredKeywords.stop, "REVOKE", "OPT OUT"]
          : requiredKeywords[op];
      if (keywords.some((word) => !supported.includes(word)))
        throw new ReviewSmsError("review_sms_campaign_keywords_unsupported");
      return [op, { op, keywords, country_code: "*", resp_text: text.trim() }];
    }),
  ) as ReviewSmsKeywordProgram;
}

const providerRuleSchema = z.object({
  id: z.string().uuid(),
  country_code: z.string().min(1),
  op: z.enum(["start", "stop", "info"]),
  keywords: z.array(z.string().min(1)).min(1),
  resp_text: z.string().optional(),
});

async function readRules(profileId: string): Promise<ProviderRule[]> {
  const response = await telnyx.messagingProfiles.autorespConfigs.list(
    profileId,
    {},
    requestOptions,
  );
  // The public endpoint does not expose page controls. An incomplete list
  // cannot prove absence and must never authorize another create.
  if (
    !Array.isArray(response.data) ||
    !response.meta ||
    response.meta.page_number !== 1 ||
    response.meta.total_pages > 1 ||
    response.meta.total_results !== response.data.length
  )
    throw new ReviewSmsError("review_sms_keywords_list_incomplete", 503);
  return response.data.map((value) => {
    const parsed = providerRuleSchema.safeParse(value);
    if (!parsed.success)
      throw new ReviewSmsError("review_sms_keywords_response_invalid", 503);
    return {
      ...parsed.data,
      keywords: parsed.data.keywords.map(keyword),
      resp_text: parsed.data.resp_text?.trim() ?? "",
    };
  });
}

function matchingRules(rules: ProviderRule[], op: Operation) {
  return rules.filter(
    (rule) => rule.op === op && ["US", "*"].includes(rule.country_code),
  );
}
function sameRule(actual: ProviderRule, expected: Rule) {
  return (
    actual.resp_text === expected.resp_text &&
    actual.keywords.length === expected.keywords.length &&
    actual.keywords.every((word) => expected.keywords.includes(word))
  );
}
function conflicts(rules: ProviderRule[]): string[] {
  const issues: string[] = [];
  for (const country of ["*", "US"]) {
    const applicable = rules.filter((rule) => rule.country_code === country);
    for (const op of operations)
      if (applicable.filter((rule) => rule.op === op).length > 1)
        issues.push(`duplicate_${country}_${op}`);
  }
  const applicable = rules.filter((rule) =>
    ["*", "US"].includes(rule.country_code),
  );
  for (const rule of applicable)
    if (
      applicable.some(
        (other) =>
          other.op !== rule.op &&
          other.keywords.some((word) => rule.keywords.includes(word)),
      )
    )
      issues.push(`conflicting_${rule.country_code}_${rule.op}`);
  return issues;
}

export async function inspectReviewSmsKeywords(
  profileId: string,
  program: ReviewSmsKeywordProgram,
): Promise<{ ready: boolean; issues: string[] }> {
  const rules = await readRules(profileId);
  const issues = conflicts(rules);
  for (const op of operations) {
    const applicable = matchingRules(rules, op);
    if (!applicable.length) issues.push(`missing_${op}`);
    else if (applicable.some((rule) => !sameRule(rule, program[op])))
      issues.push(`mismatched_${op}`);
  }
  return { ready: issues.length === 0, issues };
}

function intentId(businessId: string, profileId: string, op: Operation) {
  const hex = createHash("sha256")
    .update(`review-keywords/v1/${businessId}/${profileId}/${op}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Only the provisioning owner may call this under a fresh tenant/resource
 * claim. Reads recover completed work; deterministic durable intents prevent
 * a second POST after ambiguous creation. PUT replacements are idempotent. */
export async function ensureReviewSmsKeywords(args: {
  businessId: string;
  profileId: string;
  program: ReviewSmsKeywordProgram;
  authorizeMutation: () => Promise<void>;
}) {
  let rules = await readRules(args.profileId);
  if (conflicts(rules).length)
    throw new ReviewSmsError("review_sms_keywords_conflict");
  for (const op of operations) {
    const desired = args.program[op];
    const applicable = matchingRules(rules, op);
    if (!applicable.length) {
      await args.authorizeMutation();
      const { error } = await supabaseAdmin
        .from("telnyx_registration_events")
        .insert({
          id: intentId(args.businessId, args.profileId, op),
          business_id: args.businessId,
          event_type: "review_sms_keyword_create_intent",
          telnyx_resource_type: "messaging_profile",
          telnyx_resource_id: args.profileId,
          status: "started",
          raw_payload: { version: 1, ...desired },
        });
      if (error)
        throw new ReviewSmsError(
          error.code === "23505"
            ? "review_sms_keywords_reconciliation_required"
            : "review_sms_keywords_intent_unavailable",
          503,
        );
      await args.authorizeMutation();
      await telnyx.messagingProfiles.autorespConfigs.create(
        args.profileId,
        desired,
        requestOptions,
      );
    } else {
      for (const actual of applicable) {
        if (sameRule(actual, desired)) continue;
        await args.authorizeMutation();
        await telnyx.messagingProfiles.autorespConfigs.update(
          actual.id,
          {
            ...desired,
            country_code: actual.country_code,
            profile_id: args.profileId,
          },
          requestOptions,
        );
      }
    }
    rules = await readRules(args.profileId);
    const verified = matchingRules(rules, op);
    if (
      !verified.length ||
      conflicts(rules).length ||
      verified.some((rule) => !sameRule(rule, desired))
    )
      throw new ReviewSmsError(
        "review_sms_keywords_reconciliation_required",
        503,
      );
    const { error } = await supabaseAdmin
      .from("telnyx_registration_events")
      .update({ status: "resolved" })
      .eq("id", intentId(args.businessId, args.profileId, op))
      .eq("business_id", args.businessId)
      .eq("event_type", "review_sms_keyword_create_intent")
      .eq("telnyx_resource_id", args.profileId)
      .eq("status", "started");
    if (error)
      throw new ReviewSmsError("review_sms_keywords_intent_unavailable", 503);
  }
}
