import TextingUpgradeWizard from "@/components/billing/TextingUpgradeWizard";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";

export default async function AddTextingPage() {
  await requireWorkspacePageAccess();
  return <TextingUpgradeWizard />;
}
