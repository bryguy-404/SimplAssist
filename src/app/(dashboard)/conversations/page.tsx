import { redirect } from "next/navigation";
import { InboxLayout } from "@/components/conversations/InboxLayout";
import type { Conversation, Contact } from "@/types/database";
import { getSmsReadinessForBusiness } from "@/lib/messaging/lookup";
import { canUseFeature } from "@/lib/billing/entitlements";
import { planRequiresSmsProvisioning } from "@/lib/billing/features";
import { getDashboardEntitledContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";

export type ConversationWithContact = Conversation & {
  contact: Pick<Contact, "id" | "name" | "phone_number" | "email">;
  last_message_preview?: string;
};

type ConversationsPageProps = {
  searchParams?: {
    conversation?: string | string[];
  };
};

export default async function ConversationsPage({
  searchParams,
}: ConversationsPageProps) {
  await requireWorkspacePageAccess();
  const context = await getDashboardEntitledContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");

  const { supabase, business, entitlements } = context;
  const smsIncluded = planRequiresSmsProvisioning(entitlements.plan);
  const smsReadiness = smsIncluded
    ? await getSmsReadinessForBusiness(business.id)
    : {
        smsReady: false,
        blockReason: null,
      };
  const initialSelectedId =
    typeof searchParams?.conversation === "string" &&
    searchParams.conversation.length > 0
      ? searchParams.conversation
      : undefined;

  const { data: conversations } = await supabase
    .from("conversations")
    .select(
      `
      *,
      contact:contacts!contact_id (
        id,
        name,
        phone_number,
        email
      )
    `
    )
    .eq("business_id", business.id)
    .order("last_message_at", { ascending: false });

  // Voice fragments are not standalone messages suitable for a list preview.
  const conversationsWithPreviews: ConversationWithContact[] = await Promise.all(
    (conversations ?? []).map(async (conv: ConversationWithContact) => {
      if (conv.channel === "voice") return { ...conv, last_message_preview: "View call transcript" };
      const { data: lastMessage } = await supabase
        .from("messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      return {
        ...conv,
        last_message_preview: lastMessage?.content ?? undefined,
      };
    })
  );

  return (
    <div className="h-[calc(100vh-4rem)]">
      <InboxLayout
        conversations={conversationsWithPreviews}
        businessId={business.id}
        smsIncluded={smsIncluded}
        smsReady={smsReadiness.smsReady}
        smsBlockReason={smsReadiness.blockReason}
        canUseManualSms={canUseFeature(entitlements, "manual_sms")}
        canUseAiSms={canUseFeature(entitlements, "ai_sms_conversations")}
        canUseWebChat={canUseFeature(entitlements, "web_chat")}
        initialSelectedId={initialSelectedId}
      />
    </div>
  );
}
