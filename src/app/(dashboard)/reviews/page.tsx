import { notFound, redirect } from "next/navigation";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import ReviewsWorkspace from "@/components/reviews/ReviewsWorkspace";
import { getDashboardBusinessContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { isEmailReviewsEnabledForBusiness } from "@/lib/reviews/config";

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams?: { customer?: string | string[]; tab?: string | string[] };
}) {
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");
  if (!isEmailReviewsEnabledForBusiness(context.business.id)) notFound();
  return (
    <ReviewsWorkspace
      initialTab={searchParams?.tab === "settings" ? "settings" : "requests"}
      smsEnabled={isReviewSmsEnabled(context.business.id)}
      ownerEmail={context.user.email || ""}
      initialCustomerId={
        typeof searchParams?.customer === "string"
          ? searchParams.customer
          : undefined
      }
    />
  );
}
