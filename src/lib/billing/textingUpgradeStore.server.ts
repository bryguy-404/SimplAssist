import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TextingUpgradeError, type TextingUpgradeRecord } from "./textingUpgrade";
const upgradeSchema = z.object({
  id: z.string().uuid(), business_id: z.string().uuid(), owner_id: z.string().uuid(),
  source_subscription_id: z.string(), source_customer_id: z.string(), target_plan: z.enum(["sms_only", "sms_and_chat", "full"]),
  state: z.enum(["draft", "payment_pending", "carrier_pending", "support_required", "activated", "abandoned"]),
  billing_operation_id: z.string().uuid().nullable(), business_confirmed_at: z.string().nullable(), phone_confirmed_at: z.string().nullable(), starter_acknowledged_at: z.string().nullable(),
  paid_at: z.string().nullable(), activated_at: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
export function parseTextingUpgrade(value: unknown): TextingUpgradeRecord {
  const parsed = upgradeSchema.safeParse(value);
  if (!parsed.success) throw new TextingUpgradeError("texting_upgrade_invalid_state", 503);
  return parsed.data;
}
export async function textingUpgradeRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) {
    const code = /(?:chat_texting_upgrade|texting_upgrade|sms_billing)_[a-z_]+/.exec(error.message)?.[0] ?? "texting_upgrade_unavailable";
    throw new TextingUpgradeError(code, /forbidden/.test(code) ? 403 : /unavailable/.test(code) ? 503 : 409);
  }
  return data;
}
export async function getTextingUpgrade(businessId: string): Promise<TextingUpgradeRecord | null> {
  const { data, error } = await supabaseAdmin.from("chat_texting_upgrades").select("*").eq("business_id", businessId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new TextingUpgradeError("texting_upgrade_unavailable", 503);
  return data ? parseTextingUpgrade(data) : null;
}
