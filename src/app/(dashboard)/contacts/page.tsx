import { redirect } from "next/navigation";
import CustomersWorkspace from "@/components/customers/CustomersWorkspace";
import LegacyContactsWorkspace from "@/components/customers/LegacyContactsWorkspace";
import { customerWorkspaceEnabled } from "@/lib/billing/customerReviewsRollout.server";
import { getDashboardBusinessContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { isEmailReviewsEnabledForBusiness } from "@/lib/reviews/config";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams?: { contact?: string | string[] };
}) {
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");
  const initialSelectedId =
    typeof searchParams?.contact === "string"
      ? searchParams.contact
      : undefined;

  if (!customerWorkspaceEnabled(context.business.id)) {
    return LegacyContactsWorkspace({
      context,
      selectedContactId: initialSelectedId,
    });
  }
  return (
    <CustomersWorkspace
      initialSelectedId={initialSelectedId}
      reviewsEnabled={isEmailReviewsEnabledForBusiness(context.business.id)}
    />
  );
}
