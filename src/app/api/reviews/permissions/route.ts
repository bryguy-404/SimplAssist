import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import { recordReviewPermission } from "@/lib/reviews/service.server";
export const POST = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    recordReviewPermission(
      businessId,
      ownerId,
      await reviewRequestBody(request),
    ),
  );
