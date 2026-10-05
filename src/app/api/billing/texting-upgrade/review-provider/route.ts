import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";
import { getReviewTextingProviderState, prepareReviewTextingProvider, moveReviewTextingProvider, refreshReviewTextingProvider } from "@/lib/billing/reviewTextingProvider.server";
export const runtime="nodejs";
export const maxDuration=60;
const body=z.discriminatedUnion("action",[
  z.object({action:z.literal("prepare"),acknowledge:z.literal(true)}).strict(),
  z.object({action:z.literal("move"),acknowledge:z.literal(true)}).strict(),
  z.object({action:z.literal("refresh")}).strict(),
]);
export async function GET() {
  const c=await requireFreshWorkspaceRouteAccess();if (!c.ok) return c.response;
  try {return NextResponse.json({provider:await getReviewTextingProviderState(c.access.business.id,c.access.user.id)},{headers:{"Cache-Control":"no-store"}});}
  catch(error){return textingUpgradeFailure(error);}
}
export async function POST(request:NextRequest) {
  const c=await requireFreshWorkspaceRouteAccess();if (!c.ok) return c.response;
  const parsed=body.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return NextResponse.json({error:"invalid_request"},{status:400});
  try {
    const action=parsed.data.action==="prepare"?prepareReviewTextingProvider:parsed.data.action==="move"?moveReviewTextingProvider:refreshReviewTextingProvider;
    await action(c.access.business.id,c.access.user.id);
    return NextResponse.json({provider:await getReviewTextingProviderState(c.access.business.id,c.access.user.id)});
  } catch(error){return textingUpgradeFailure(error);}
}
