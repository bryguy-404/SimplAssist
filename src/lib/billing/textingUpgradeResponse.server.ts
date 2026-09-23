import { NextResponse } from "next/server";
import { TextingUpgradeError } from "./textingUpgrade";
import { SmsBillingError } from "@/lib/stripe/smsBilling";
export function textingUpgradeFailure(error: unknown) {
  if (error instanceof TextingUpgradeError || error instanceof SmsBillingError) return NextResponse.json({ error: error.code }, { status: error.httpStatus });
  console.error("[texting-upgrade] Action failed", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: "texting_upgrade_unavailable", retryable: true }, { status: 503 });
}
