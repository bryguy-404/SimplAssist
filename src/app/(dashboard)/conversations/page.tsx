import { redirect } from "next/navigation";
import { z } from "zod";
import { InboxLayout } from "@/components/conversations/InboxLayout";
import { getSmsReadinessForBusiness } from "@/lib/messaging/lookup";
import { canUseFeature } from "@/lib/billing/entitlements";
import { planRequiresSmsProvisioning } from "@/lib/billing/features";
import { getDashboardEntitledContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { readInboxPage } from "@/lib/conversations/inbox.server";
export type { ConversationWithContact } from "@/lib/conversations/inbox";

export default async function ConversationsPage({ searchParams }: {
  searchParams?: { conversation?: string | string[]; folder?: string | string[] };
}) {
  await requireWorkspacePageAccess();
  const context = await getDashboardEntitledContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");
  const { business, user, entitlements } = context;
  const smsIncluded = planRequiresSmsProvisioning(entitlements.plan);
  const focus = z.string().uuid().safeParse(searchParams?.conversation);
  const folder = searchParams?.folder === "spam" ? "spam" : "inbox";
  const [smsReadiness, page] = await Promise.all([
    smsIncluded ? getSmsReadinessForBusiness(business.id) : Promise.resolve({ smsReady: false, blockReason: null }),
    readInboxPage(business.id, user.id, { folder, channel: "all", search: "", focus: focus.success ? focus.data : undefined }),
  ]);
  return (
    <div className="h-[calc(100vh-4rem)]">
      <InboxLayout
        key={`${page.folder}:${page.selected?.id ?? ""}`}
        conversations={page.conversations} initialPage={page}
        businessId={business.id} smsIncluded={smsIncluded}
        smsReady={smsReadiness.smsReady} smsBlockReason={smsReadiness.blockReason}
        canUseManualSms={canUseFeature(entitlements, "manual_sms")}
        canUseAiSms={canUseFeature(entitlements, "ai_sms_conversations")}
        canUseWebChat={canUseFeature(entitlements, "web_chat")}
        initialSelectedId={page.selected?.id}
      />
    </div>
  );
}
