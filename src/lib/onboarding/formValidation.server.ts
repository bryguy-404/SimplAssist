import { z } from "zod";
import { normalizeUsStateCode } from "@/lib/usStates";
import { A2P_RISK_CHECKLIST_ANSWERS, isA2pRiskSelection } from "@/lib/messaging/registration/riskCategories";
const PLACEHOLDER_PATTERN = /\[.+?\]/;
const STOP_PATTERN = /\bstop\b/i;

const BUSINESS_TYPES = [
  "plumber",
  "dentist",
  "restaurant",
  "car_wash",
  "salon",
  "hvac",
  "auto_shop",
  "real_estate",
  "legal",
  "financial",
  "insurance",
  "retail",
  "general",
  "other",
] as const;

export const BusinessInfoSchema = z
  .object({
    name: z.string().trim().min(1, "Business name is required"),
    business_type: z.enum(BUSINESS_TYPES),
    business_type_other: z.string().trim().optional(),
    website: z.string().trim().url("Enter a valid URL").or(z.literal("")),
    phone: z.string().trim().min(10, "Enter a valid phone number"),
    email: z
      .string()
      .trim()
      .email("Enter a valid email address")
      .min(1, "Business email is required"),
    address: z.string().trim().min(1, "Address is required"),
    city: z.string().trim().min(1, "City is required"),
    state: z
      .string()
      .trim()
      .min(1, "State is required")
      .refine(
        (value) => Boolean(normalizeUsStateCode(value)),
        "Select a valid state",
      ),
    zip: z.string().trim().min(5, "Enter a valid zip code"),
    timezone: z.string().trim().min(1).max(100),
  })
  .strict()
  .refine(
    (data) =>
      data.business_type !== "other" || Boolean(data.business_type_other),
    {
      message: "Please specify your business type",
      path: ["business_type_other"],
    },
  );

function hasFirstAndLastName(value: string): boolean {
  return value.trim().split(/\s+/).length >= 2;
}

const einPathSchema = z.object({
  businessId: z.string().uuid(),
  has_ein: z.literal(true),
  legal_business_name: z.string().min(1),
  business_entity_type: z.enum(["llc", "c_corp", "s_corp", "nonprofit", "partnership"]),
  business_registration_state: z
    .string()
    .min(2)
    .refine((value) => Boolean(normalizeUsStateCode(value))),
  ein: z.string().regex(/^\d{2}-\d{7}$/),
  authorized_rep_name: z
    .string()
    .min(1)
    .refine(
      hasFirstAndLastName,
      "Representative name must include first and last name"
    ),
  authorized_rep_title: z.string().min(1),
  authorized_rep_email: z.string().email(),
  authorized_rep_phone: z.string().min(10),
});

const noEinPathSchema = z.object({
  businessId: z.string().uuid(),
  has_ein: z.literal(false),
  join_waitlist: z.boolean().optional(),
});

export const brandVerificationServerSchema = z.discriminatedUnion("has_ein", [
  einPathSchema,
  noEinPathSchema,
]);

export const smsUseCaseSchema = z
  .object({
    businessId: z.string().uuid(),
    use_case_description: z.string().min(40),
    estimated_monthly_volume: z.enum([
      "under_1k",
      "1k_10k",
      "10k_100k",
      "over_100k",
    ]),
    sample_messages: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (value) => !PLACEHOLDER_PATTERN.test(value),
            "Sample messages cannot contain placeholders"
          )
      )
      .min(3)
      .max(5),
    opt_in_description: z.string().min(40),
    a2p_risk_checklist_answer: z.enum(A2P_RISK_CHECKLIST_ANSWERS),
    a2p_risk_checklist_selections: z.array(z.string()).default([]),
  })
  .refine(
    (data) =>
      data.a2p_risk_checklist_answer !== "restricted" ||
      data.a2p_risk_checklist_selections.some(isA2pRiskSelection),
    {
      message: "Select at least one restricted category, or choose a different answer",
      path: ["a2p_risk_checklist_selections"],
    }
  )
  .refine(
    (data) => data.sample_messages.some((sample) => STOP_PATTERN.test(sample)),
    {
      message: "At least one sample message must mention STOP opt-out wording",
      path: ["sample_messages"],
    }
  );
