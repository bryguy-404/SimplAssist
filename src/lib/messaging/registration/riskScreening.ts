import "server-only";

import crypto from "crypto";
import { crawlSite, CRAWL_RISK_OPTS } from "@/lib/firecrawl/crawl";
import {
  validatePublicHttpUrl,
  withTimeout,
  limitText,
  WEBSITE_FETCH_TIMEOUT_MS,
  MAX_WEBSITE_TEXT_CHARS,
} from "@/lib/firecrawl/webFetch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  A2P_RISK_BLOCKED_MESSAGE,
  A2P_RISK_CUSTOMER_REVIEW_MESSAGE,
  A2P_RISK_PASSED_MESSAGE,
  A2P_RISK_SELECTION_LABELS,
  isA2pRiskSelection,
  type A2pRiskSelection,
} from "./riskCategories";
import { sendA2pRiskReviewEmail } from "@/lib/email/a2pRiskReview";
import type {
  A2pRiskChecklistAnswer,
  A2pRiskFinding,
  A2pRiskReviewStatus,
  BusinessType,
  OnboardingRegistrationStatus,
} from "@/types/database";

const OVERALL_SCAN_TIMEOUT_MS = 28_000;
const MAX_EVIDENCE_PER_RULE = 3;

// Crawler generation (single-page scanning was the implicit v1; multi-page is
// v2). Folded into hashA2pRiskInput so bumping it invalidates every cached
// decision — businesses that "passed" under the old crawler are re-screened on
// their next launch/registration attempt. Already-registered businesses are
// still shielded by registrationHasStartedForRisk.
const CRAWLER_VERSION = 2;

type FindingSeverity = "block" | "review";

interface Rule {
  ruleId: string;
  category: string;
  label: string;
  severity: FindingSeverity;
  patterns: RegExp[];
}

interface TextSource {
  source: string;
  text: string;
}

interface BusinessRiskRow {
  id: string;
  name: string | null;
  business_type: BusinessType | null;
  business_type_other: string | null;
  website_url: string | null;
  use_case_description: string | null;
  sample_messages: string[] | null;
  opt_in_description: string | null;
  a2p_risk_review_status: A2pRiskReviewStatus | null;
  a2p_risk_review_input_hash: string | null;
  a2p_risk_review_notified_at: string | null;
  a2p_risk_review_customer_answer: A2pRiskChecklistAnswer | null;
  a2p_risk_review_customer_selections: string[] | null;
  telnyx_brand_id: string | null;
  brand_status: string | null;
  campaign_status: string | null;
  onboarding_registration_status: OnboardingRegistrationStatus | null;
}

interface ServiceRow {
  name: string;
  description: string | null;
}

interface FaqRow {
  question: string;
  answer: string;
}

export interface A2pRiskCandidateFields {
  useCaseDescription?: string;
  sampleMessages?: string[];
  optInDescription?: string;
  checklistAnswer?: A2pRiskChecklistAnswer;
  checklistSelections?: string[];
}

export interface A2pRiskInput {
  businessId: string;
  businessName: string;
  businessType: BusinessType | null;
  businessTypeOther: string | null;
  websiteUrl: string | null;
  services: ServiceRow[];
  faqs: FaqRow[];
  useCaseDescription: string;
  sampleMessages: string[];
  optInDescription: string;
  checklistAnswer: A2pRiskChecklistAnswer | null;
  checklistSelections: string[];
}

export interface A2pRiskReviewResult {
  status: A2pRiskReviewStatus;
  inputHash: string;
  message: string;
  reason: string | null;
  findings: A2pRiskFinding[];
  registrationStarted: boolean;
  reusedExisting: boolean;
}

export interface A2pRiskClearanceResult {
  cleared: boolean;
  status: A2pRiskReviewStatus;
  inputHash: string;
  /** Whether the stored screening hash matches the current inputs. */
  hashMatches: boolean;
  message: string;
  reason: string | null;
  findings: A2pRiskFinding[];
  registrationStarted: boolean;
}

const BLOCK_RULES: Rule[] = [
  {
    ruleId: "701_cannabis_cbd",
    category: "cannabis_cbd",
    label: "Cannabis, CBD, hemp, marijuana, or derivatives",
    severity: "block",
    patterns: [
      /\bcannabis\b/i,
      /\bmarijuana\b/i,
      /\bhemp\b/i,
      /\bcbd\b/i,
      /\bthc\b/i,
      /\bdispensary\b/i,
      /\bpre[-\s]?rolls?\b/i,
      /\bedibles?\b/i,
      /\bdrug paraphernalia\b/i,
    ],
  },
  {
    ruleId: "702_firearms_weapons",
    category: "firearms_weapons",
    label: "Firearms, weapons, or ammunition",
    severity: "block",
    patterns: [
      /\bfirearms?\b/i,
      /\bguns?\b/i,
      /\bammunition\b/i,
      /\bammo\b/i,
      /\brifles?\b/i,
      /\bhandguns?\b/i,
      /\bweapons?\b/i,
    ],
  },
  {
    ruleId: "703_adult_sexual",
    category: "adult_dating",
    label: "Adult, sexual, escort, dating, or hookup services",
    severity: "block",
    patterns: [
      /\badult entertainment\b/i,
      /\bescort(s|ing)?\b/i,
      /\bsexual\b/i,
      /\bporn(ography)?\b/i,
      /\bhookups?\b/i,
      /\bdating app\b/i,
      /\berotic\b/i,
    ],
  },
  {
    ruleId: "704_gambling",
    category: "gambling",
    label: "Gambling, casinos, sports betting, sweepstakes, or lottery-style games",
    severity: "block",
    patterns: [
      /\bgambling\b/i,
      /\bcasino\b/i,
      /\bsports betting\b/i,
      /\bbookmaker\b/i,
      /\blottery\b/i,
      /\bsweepstakes\b/i,
      /\bgames? of chance\b/i,
      /\bpoker\b/i,
    ],
  },
  {
    ruleId: "705_hate_illegal_deceptive",
    category: "deceptive_illegal",
    label: "Hate, illegal, deceptive, phishing, scam-like, or profanity-heavy content",
    severity: "block",
    patterns: [
      /\bhate speech\b/i,
      /\bwhite supremac/i,
      /\bphishing\b/i,
      /\bscam\b/i,
      /\billegal\b/i,
      /\bfraud\b/i,
      /\bdeceptive\b/i,
    ],
  },
  {
    ruleId: "708_lead_gen_seo_affiliate",
    category: "lead_gen_seo",
    label: "Lead generation, SEO, affiliate marketing, bought leads, or cold outreach",
    severity: "block",
    patterns: [
      /\blead generation\b/i,
      /\blead gen\b/i,
      /\bgenerate (more )?leads\b/i,
      /\bbuy leads\b/i,
      /\bsell leads\b/i,
      /\blead sales\b/i,
      /\bpurchased leads\b/i,
      /\bprospect lists?\b/i,
      /\bcold outreach\b/i,
      /\bcold email\b/i,
      /\bcold sms\b/i,
      /\baffiliate marketing\b/i,
      /\baffiliate offers?\b/i,
      /\breferral offers?\b/i,
      /\bseo\b/i,
      /\bsearch engine optimization\b/i,
    ],
  },
  {
    ruleId: "709_high_risk_finance",
    category: "high_risk_finance",
    label: "High-risk financial services, debt, credit repair, crypto, or trading",
    severity: "block",
    patterns: [
      /\bpayday loans?\b/i,
      /\bshort[-\s]?term loans?\b/i,
      /\bdebt relief\b/i,
      /\bdebt collection\b/i,
      /\bdebt forgiveness\b/i,
      /\bcredit repair\b/i,
      /\bloan brokering\b/i,
      /\bnon[-\s]?direct lender\b/i,
      /\bcrypto(currency)?\b/i,
      /\bstock trading\b/i,
      /\btrading signals?\b/i,
      /\binvestment promises?\b/i,
    ],
  },
  {
    ruleId: "prescription_pharmacy",
    category: "prescription_pharmacy",
    label: "Prescription, pharmacy, or telemedicine prescription services",
    severity: "block",
    patterns: [
      /\bprescription drugs?\b/i,
      /\bonline pharmacy\b/i,
      /\bpharmacy\b/i,
      /\btelemedicine prescriptions?\b/i,
      /\bweight loss medication\b/i,
    ],
  },
  {
    ruleId: "mlm_get_rich_quick",
    category: "mlm_income",
    label: "Make-money-online, passive income, MLM, or network marketing",
    severity: "block",
    patterns: [
      /\bmake money online\b/i,
      /\bget rich quick\b/i,
      /\bpassive income\b/i,
      /\bmlm\b/i,
      /\bnetwork marketing\b/i,
      /\bmulti[-\s]?level marketing\b/i,
    ],
  },
  {
    ruleId: "political_messaging",
    category: "political",
    label: "Political messaging, donations, polling, advocacy, or campaign work",
    severity: "block",
    patterns: [
      /\bpolitical\b/i,
      /\belection\b/i,
      /\bcampaign donations?\b/i,
      /\bpolling\b/i,
      /\badvocacy campaign\b/i,
      /\bvote for\b/i,
      /\bpac\b/i,
    ],
  },
];

const REVIEW_RULES: Rule[] = [
  {
    ruleId: "706_alcohol_age_gated",
    category: "alcohol_tobacco_vape",
    label: "Alcohol or other age-gated products",
    severity: "review",
    patterns: [/\balcohol\b/i, /\bbeer\b/i, /\bwine\b/i, /\bliquor\b/i, /\bspirits\b/i],
  },
  {
    ruleId: "707_tobacco_vape_age_gated",
    category: "alcohol_tobacco_vape",
    label: "Tobacco, vaping, nicotine, or other age-gated products",
    severity: "review",
    patterns: [
      /\btobacco\b/i,
      /\bvape\b/i,
      /\bvaping\b/i,
      /\bnicotine\b/i,
      /\be[-\s]?cig/i,
    ],
  },
  {
    ruleId: "generic_marketing_agency",
    category: "marketing_agency",
    label: "Marketing agency services need manual review before Customer Care SMS",
    severity: "review",
    patterns: [
      /\bmarketing agency\b/i,
      /\bdigital marketing\b/i,
      /\badvertising agency\b/i,
      /\bsocial media marketing\b/i,
      /\bmarketing services\b/i,
    ],
  },
];

const SELECTION_SEVERITY: Record<A2pRiskSelection, FindingSeverity> = {
  lead_gen_seo: "block",
  marketing_agency: "review",
  affiliate_marketing: "block",
  mlm_income: "block",
  high_risk_finance: "block",
  cannabis_cbd: "block",
  prescription_pharmacy: "block",
  gambling: "block",
  adult_dating: "block",
  firearms_weapons: "block",
  political: "block",
  alcohol_tobacco_vape: "review",
  other_regulated_deceptive: "review",
};

export async function buildA2pRiskInputForBusiness(
  businessId: string,
  candidate: A2pRiskCandidateFields = {}
): Promise<{ input: A2pRiskInput; business: BusinessRiskRow }> {
  const [{ data: business, error }, { data: services }, { data: faqs }] =
    await Promise.all([
      supabaseAdmin
        .from("businesses")
        .select(
          [
            "id",
            "name",
            "business_type",
            "business_type_other",
            "website_url",
            "use_case_description",
            "sample_messages",
            "opt_in_description",
            "a2p_risk_review_status",
            "a2p_risk_review_input_hash",
            "a2p_risk_review_notified_at",
            "a2p_risk_review_customer_answer",
            "a2p_risk_review_customer_selections",
            "telnyx_brand_id",
            "brand_status",
            "campaign_status",
            "onboarding_registration_status",
          ].join(", ")
        )
        .eq("id", businessId)
        .single<BusinessRiskRow>(),
      supabaseAdmin
        .from("services")
        .select("name, description")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .returns<ServiceRow[]>(),
      supabaseAdmin
        .from("faqs")
        .select("question, answer")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .returns<FaqRow[]>(),
    ]);

  if (error || !business) {
    throw new Error(
      `[a2p-risk] Business ${businessId} not found: ${error?.message}`
    );
  }

  const input: A2pRiskInput = {
    businessId,
    businessName: business.name ?? "Your Business",
    businessType: business.business_type,
    businessTypeOther: business.business_type_other,
    websiteUrl: normalizeNullable(business.website_url),
    services: services ?? [],
    faqs: faqs ?? [],
    useCaseDescription:
      candidate.useCaseDescription ?? business.use_case_description ?? "",
    sampleMessages:
      candidate.sampleMessages ?? business.sample_messages ?? [],
    optInDescription:
      candidate.optInDescription ?? business.opt_in_description ?? "",
    checklistAnswer:
      candidate.checklistAnswer ?? business.a2p_risk_review_customer_answer,
    checklistSelections:
      candidate.checklistSelections ??
      business.a2p_risk_review_customer_selections ??
      [],
  };

  return { input, business };
}

export function hashA2pRiskInput(input: A2pRiskInput): string {
  const canonical = {
    businessName: clean(input.businessName),
    businessType: input.businessType,
    businessTypeOther: clean(input.businessTypeOther),
    websiteUrl: clean(input.websiteUrl),
    services: input.services.map((service) => ({
      name: clean(service.name),
      description: clean(service.description),
    })),
    faqs: input.faqs.map((faq) => ({
      question: clean(faq.question),
      answer: clean(faq.answer),
    })),
    useCaseDescription: clean(input.useCaseDescription),
    sampleMessages: input.sampleMessages.map(clean),
    optInDescription: clean(input.optInDescription),
    checklistAnswer: input.checklistAnswer,
    checklistSelections: [...input.checklistSelections].sort(),
    crawlerVersion: CRAWLER_VERSION,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function registrationHasStartedForRisk(
  business: {
    telnyx_brand_id: string | null;
    brand_status: string | null;
    campaign_status: string | null;
    onboarding_registration_status: OnboardingRegistrationStatus | null;
  }
): boolean {
  return Boolean(
    business.telnyx_brand_id ||
      business.brand_status ||
      business.campaign_status ||
      business.onboarding_registration_status === "submitted"
  );
}

export async function getA2pRiskClearanceForBusiness(
  businessId: string
): Promise<A2pRiskClearanceResult> {
  const { input, business } = await buildA2pRiskInputForBusiness(businessId);
  const inputHash = hashA2pRiskInput(input);
  const registrationStarted = registrationHasStartedForRisk(business);
  const currentHashMatches = business.a2p_risk_review_input_hash === inputHash;

  if (registrationStarted) {
    return {
      cleared: true,
      status: business.a2p_risk_review_status ?? "not_started",
      inputHash,
      hashMatches: currentHashMatches,
      message: "Registration has already started.",
      reason: null,
      findings: [],
      registrationStarted: true,
    };
  }

  const storedStatus = business.a2p_risk_review_status ?? "not_started";
  const cleared =
    currentHashMatches &&
    (storedStatus === "passed" || storedStatus === "admin_approved");

  return {
    cleared,
    status: currentHashMatches ? storedStatus : "not_started",
    inputHash,
    hashMatches: currentHashMatches,
    message:
      currentHashMatches && business.a2p_risk_review_status === "blocked"
        ? A2P_RISK_BLOCKED_MESSAGE
        : currentHashMatches &&
            business.a2p_risk_review_status === "pending_review"
          ? A2P_RISK_CUSTOMER_REVIEW_MESSAGE
          : cleared
            ? A2P_RISK_PASSED_MESSAGE
            : "Complete the SMS use-case review before continuing.",
    reason: null,
    findings: [],
    registrationStarted: false,
  };
}

export async function screenA2pRiskForBusiness(
  businessId: string,
  candidate: A2pRiskCandidateFields,
  options: {
    /**
     * Run the screen even when registration has already started. Used by the
     * retry path when the risk-input hash no longer matches the stored
     * decision (content edited since the last screening) — the fresh result
     * is persisted so flagged content routes to manual review instead of
     * auto-clearing on resubmission.
     */
    force?: boolean;
    /** Assess a draft without writes; its owner persists the result atomically. */
    persist?: boolean;
  } = {}
): Promise<A2pRiskReviewResult> {
  const { input, business } = await buildA2pRiskInputForBusiness(
    businessId,
    candidate
  );
  const inputHash = hashA2pRiskInput(input);
  const registrationStarted = registrationHasStartedForRisk(business);

  if (registrationStarted && !options.force) {
    return {
      status: business.a2p_risk_review_status ?? "not_started",
      inputHash,
      message: "Registration has already started.",
      reason: null,
      findings: [],
      registrationStarted,
      reusedExisting: true,
    };
  }

  if (
    business.a2p_risk_review_input_hash === inputHash &&
    business.a2p_risk_review_status &&
    business.a2p_risk_review_status !== "not_started"
  ) {
    return {
      status: business.a2p_risk_review_status,
      inputHash,
      message: messageForStatus(business.a2p_risk_review_status),
      reason: null,
      findings: [],
      registrationStarted,
      reusedExisting: true,
    };
  }

  let result = await withTimeout(
    runDeterministicScan(input, inputHash),
    OVERALL_SCAN_TIMEOUT_MS,
    timeoutReviewResult(inputHash)
  );

  if (
    options.force &&
    business.a2p_risk_review_status === "admin_approved" &&
    result.status === "blocked"
  ) {
    // A previously admin-approved business must not be silently hard-blocked
    // by an automated re-screen of edited content: route it back to manual
    // review (which notifies the admin) so a human makes the final call.
    result = {
      ...result,
      status: "pending_review",
      message: A2P_RISK_CUSTOMER_REVIEW_MESSAGE,
    };
  }

  if (options.persist !== false) {
    await persistRiskResult({ businessId, input, result });
  }

  if (options.persist !== false && result.status === "pending_review") {
    await notifyReviewIfNeeded({
      businessId,
      businessName: input.businessName,
      websiteUrl: input.websiteUrl,
      inputHash,
      findings: result.findings,
      message: result.message,
    });
  }

  return {
    ...result,
    registrationStarted,
    reusedExisting: false,
  };
}

/** Uses the established scanner without updating shared business state or sending mail. */
export async function assessA2pRiskForBusiness(
  businessId: string, candidate: A2pRiskCandidateFields,
): Promise<A2pRiskReviewResult> {
  return screenA2pRiskForBusiness(businessId, candidate, { persist: false });
}

async function runDeterministicScan(
  input: A2pRiskInput,
  inputHash: string
): Promise<Omit<A2pRiskReviewResult, "registrationStarted" | "reusedExisting">> {
  const sources: TextSource[] = buildTextSources(input);
  const findings: A2pRiskFinding[] = [];

  findings.push(...findChecklistRisks(input));

  if (input.websiteUrl) {
    const websiteScan = await readWebsiteForRisk(input.websiteUrl);
    if (websiteScan.ok) {
      // One source per crawled page so the deterministic rules run over every
      // page's full text. A prohibited /menu is matched on its own budget and
      // can't be hidden by a clean homepage or truncated away by another page.
      for (const page of websiteScan.pages) {
        sources.push({ source: `website ${page.url}`, text: page.text });
      }
      // Fail closed on risk-relevant pages we discovered but couldn't fetch:
      // route to manual review rather than passing on a transient miss of the
      // exact pages (menu/shop/products/pricing) most likely to carry risk.
      if (websiteScan.failedRiskRelevant.length > 0) {
        findings.push({
          ruleId: "website_subpage_unavailable",
          category: "manual_review",
          severity: "review",
          label: "A key website page could not be scanned before submission",
          evidence: websiteScan.failedRiskRelevant
            .slice(0, MAX_EVIDENCE_PER_RULE)
            .map((path) => `Could not read ${path}`),
          source: "website",
        });
      }
    } else {
      findings.push({
        ruleId: "website_scan_unavailable",
        category: "manual_review",
        severity: "review",
        label: "Website could not be scanned before submission",
        evidence: [websiteScan.reason],
        source: "website",
      });
    }
  }

  findings.push(...findRuleMatches([...BLOCK_RULES, ...REVIEW_RULES], sources));

  const merged = mergeFindings(findings);
  const status = statusFromFindings(merged);

  return {
    status,
    inputHash,
    message: messageForStatus(status),
    reason: reasonFromFindings(merged),
    findings: merged,
  };
}

function buildTextSources(input: A2pRiskInput): TextSource[] {
  const serviceText = input.services
    .map((service) => [service.name, service.description].filter(Boolean).join(": "))
    .join("\n");
  const faqText = input.faqs
    .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
    .join("\n");

  return [
    {
      source: "business_profile",
      text: [
        input.businessName,
        input.businessType,
        input.businessTypeOther,
      ]
        .filter(Boolean)
        .join(" "),
    },
    { source: "services", text: serviceText },
    { source: "faqs", text: faqText },
    { source: "use_case", text: input.useCaseDescription },
    { source: "sample_messages", text: input.sampleMessages.join("\n") },
    { source: "opt_in", text: input.optInDescription },
  ].filter((source) => source.text.trim().length > 0);
}

function findChecklistRisks(input: A2pRiskInput): A2pRiskFinding[] {
  if (input.checklistAnswer === "not_sure") {
    return [
      {
        ruleId: "customer_not_sure",
        category: "manual_review",
        severity: "review",
        label: "Customer asked SimplAssist to review restricted-service fit",
        evidence: ["Customer selected: I'm not sure / please review this."],
        source: "customer_checklist",
      },
    ];
  }

  if (input.checklistAnswer !== "restricted") return [];

  return input.checklistSelections
    .filter(isA2pRiskSelection)
    .map((selection) => ({
      ruleId: `customer_${selection}`,
      category: selection,
      severity: SELECTION_SEVERITY[selection],
      label: A2P_RISK_SELECTION_LABELS[selection],
      evidence: [`Customer selected: ${A2P_RISK_SELECTION_LABELS[selection]}`],
      source: "customer_checklist",
    }));
}

function findRuleMatches(rules: Rule[], sources: TextSource[]): A2pRiskFinding[] {
  const findings: A2pRiskFinding[] = [];

  for (const rule of rules) {
    const evidence: string[] = [];
    const hitSources = new Set<string>();

    for (const source of sources) {
      for (const pattern of rule.patterns) {
        const snippet = snippetForPattern(source.text, pattern);
        if (!snippet) continue;
        evidence.push(`${source.source}: ${snippet}`);
        hitSources.add(source.source);
        if (evidence.length >= MAX_EVIDENCE_PER_RULE) break;
      }
      if (evidence.length >= MAX_EVIDENCE_PER_RULE) break;
    }

    if (evidence.length > 0) {
      findings.push({
        ruleId: rule.ruleId,
        category: rule.category,
        severity: rule.severity,
        label: rule.label,
        evidence,
        source: Array.from(hitSources).join(", "),
      });
    }
  }

  return findings;
}

function mergeFindings(findings: A2pRiskFinding[]): A2pRiskFinding[] {
  const byRule = new Map<string, A2pRiskFinding>();
  for (const finding of findings) {
    const existing = byRule.get(finding.ruleId);
    if (!existing) {
      byRule.set(finding.ruleId, {
        ...finding,
        evidence: finding.evidence.slice(0, MAX_EVIDENCE_PER_RULE),
      });
      continue;
    }
    existing.evidence = Array.from(
      new Set([...existing.evidence, ...finding.evidence])
    ).slice(0, MAX_EVIDENCE_PER_RULE);
  }
  return Array.from(byRule.values());
}

function statusFromFindings(findings: A2pRiskFinding[]): A2pRiskReviewStatus {
  if (findings.some((finding) => finding.severity === "block")) {
    return "blocked";
  }
  if (findings.some((finding) => finding.severity === "review")) {
    return "pending_review";
  }
  return "passed";
}

function reasonFromFindings(findings: A2pRiskFinding[]): string | null {
  const first = findings[0];
  if (!first) return null;
  return first.label;
}

function messageForStatus(status: A2pRiskReviewStatus): string {
  if (status === "blocked") return A2P_RISK_BLOCKED_MESSAGE;
  if (status === "pending_review") return A2P_RISK_CUSTOMER_REVIEW_MESSAGE;
  if (status === "passed" || status === "admin_approved") {
    return A2P_RISK_PASSED_MESSAGE;
  }
  return "Complete the SMS use-case review before continuing.";
}

function timeoutReviewResult(
  inputHash: string
): Omit<A2pRiskReviewResult, "registrationStarted" | "reusedExisting"> {
  return {
    status: "pending_review",
    inputHash,
    message: A2P_RISK_CUSTOMER_REVIEW_MESSAGE,
    reason: "Website scan timed out",
    findings: [
      {
        ruleId: "scan_timeout",
        category: "manual_review",
        severity: "review",
        label: "Website scan timed out",
        evidence: [
          "The risk scan did not finish before the safe timeout window.",
        ],
        source: "scanner",
      },
    ],
  };
}

async function persistRiskResult(args: {
  businessId: string;
  input: A2pRiskInput;
  result: Omit<A2pRiskReviewResult, "registrationStarted" | "reusedExisting">;
}): Promise<void> {
  const now = new Date().toISOString();
  const { businessId, input, result } = args;
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      a2p_risk_review_status: result.status,
      a2p_risk_review_input_hash: result.inputHash,
      a2p_risk_review_message: result.message,
      a2p_risk_review_reason: result.reason,
      a2p_risk_review_findings: result.findings,
      a2p_risk_review_customer_answer: input.checklistAnswer,
      a2p_risk_review_customer_selections: input.checklistSelections,
      a2p_risk_review_scanned_at: now,
      a2p_risk_review_updated_at: now,
      a2p_risk_review_notified_at: null,
    })
    .eq("id", businessId)
    .or(
      [
        "a2p_risk_review_status.is.null",
        `a2p_risk_review_status.neq.${result.status}`,
        "a2p_risk_review_input_hash.is.null",
        `a2p_risk_review_input_hash.neq.${result.inputHash}`,
      ].join(",")
    );

  if (error) {
    throw new Error(
      `[a2p-risk] Failed to persist screening result for ${businessId}: ${error.message}`
    );
  }

  await appendRiskEvent({
    businessId,
    eventType:
      result.status === "passed"
        ? "scan_passed"
        : result.status === "blocked"
          ? "scan_blocked"
          : "scan_pending_review",
    status: result.status,
    inputHash: result.inputHash,
    message: result.message,
    findings: result.findings,
  });
}

async function notifyReviewIfNeeded(args: {
  businessId: string;
  businessName: string;
  websiteUrl: string | null;
  inputHash: string;
  findings: A2pRiskFinding[];
  message: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .update({
      a2p_risk_review_notified_at: now,
      a2p_risk_review_updated_at: now,
    })
    .eq("id", args.businessId)
    .eq("a2p_risk_review_status", "pending_review")
    .eq("a2p_risk_review_input_hash", args.inputHash)
    .is("a2p_risk_review_notified_at", null)
    .select("id");

  if (error) {
    console.error(
      `[a2p-risk] Failed to claim review notification for ${args.businessId}:`,
      error
    );
    return;
  }

  if (!data || data.length === 0) return;

  await sendA2pRiskReviewEmail({
    businessId: args.businessId,
    businessName: args.businessName,
    websiteUrl: args.websiteUrl,
    inputHash: args.inputHash,
    findings: args.findings,
    message: args.message,
  });

  await appendRiskEvent({
    businessId: args.businessId,
    eventType: "review_email_sent",
    status: "pending_review",
    inputHash: args.inputHash,
    message: args.message,
    findings: args.findings,
  });
}

export async function appendRiskEvent(args: {
  businessId: string;
  eventType: string;
  status?: A2pRiskReviewStatus | null;
  inputHash?: string | null;
  message?: string | null;
  findings?: A2pRiskFinding[] | null;
  rawPayload?: unknown;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("a2p_risk_review_events").insert({
    business_id: args.businessId,
    event_type: args.eventType,
    status: args.status ?? null,
    input_hash: args.inputHash ?? null,
    message: args.message ?? null,
    findings: args.findings ?? null,
    raw_payload: args.rawPayload ?? null,
  });

  if (error) {
    console.error(
      `[a2p-risk] Failed to append ${args.eventType} for ${args.businessId}:`,
      error
    );
  }
}

async function readWebsiteForRisk(
  websiteUrl: string
): Promise<
  | { ok: true; pages: { url: string; text: string }[]; failedRiskRelevant: string[] }
  | { ok: false; reason: string }
> {
  try {
    const safeUrl = await validatePublicHttpUrl(websiteUrl);

    // Multi-page crawl (homepage + discovered risk-relevant subpages), all via
    // Firecrawl so JS-rendered menu/shop/product pages are actually read.
    const crawl = await crawlSite(safeUrl, CRAWL_RISK_OPTS);

    // The homepage is the anchor, fetched exactly as before: prefer the
    // crawler's Firecrawl markdown, else fall back to a native fetch. If neither
    // yields content the scan is unavailable (a review finding upstream) — no
    // worse than today's single-page behavior.
    let homepageText = crawl.homepageOk ? crawl.homepageMarkdown : "";
    if (!homepageText.trim()) {
      homepageText = await fetchWebsiteText(safeUrl);
    }
    if (!homepageText.trim()) {
      return { ok: false, reason: "Website returned no readable content" };
    }

    // One source per page, each capped INDEPENDENTLY at MAX_WEBSITE_TEXT_CHARS.
    // The homepage keeps its full budget (element 0); subpages are purely
    // additive, so a prohibited subpage can never be truncated away.
    const pages = [
      { url: safeUrl, text: limitText(homepageText) },
      ...crawl.subpages.map((page) => ({
        url: page.url,
        text: limitText(page.markdown),
      })),
    ];

    return { ok: true, pages, failedRiskRelevant: crawl.failedRiskRelevant };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Website scan failed",
    };
  }
}

async function fetchWebsiteText(url: string): Promise<string> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount < 4; redirectCount++) {
    const safeUrl = await validatePublicHttpUrl(currentUrl);
    const response = await fetch(safeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "SimplAssist A2P compliance scanner",
        accept: "text/html,text/plain,application/xhtml+xml",
      },
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      currentUrl = new URL(response.headers.get("location")!, safeUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`Website returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text|html|xml|json/i.test(contentType)) {
      throw new Error("Website did not return readable text");
    }

    const raw = await readResponseText(response);
    return stripHtml(raw);
  }

  throw new Error("Website redirected too many times");
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBSITE_TEXT_CHARS * 4) break;
    output += decoder.decode(value, { stream: true });
    if (output.length > MAX_WEBSITE_TEXT_CHARS) break;
  }

  output += decoder.decode();
  return output;
}

function snippetForPattern(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - 45);
  const end = Math.min(text.length, match.index + match[0].length + 45);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeNullable(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}
