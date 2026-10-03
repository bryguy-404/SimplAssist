import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import { recordReviewPermission } from "@/lib/reviews/service.server";
import { reviewPermissionStatus } from "@/lib/reviews/permissionStatus.server";
export const GET = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    reviewPermissionStatus(
      businessId,
      ownerId,
      new URL(request.url).searchParams.get("contactId"),
    ),
  );
export const POST = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    recordReviewPermission(
      businessId,
      ownerId,
      await reviewRequestBody(request),
    ),
  );
