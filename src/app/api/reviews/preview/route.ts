import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import { createReviewPreview } from "@/lib/reviews/service.server";
export const POST = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    createReviewPreview(businessId, ownerId, await reviewRequestBody(request)),
  );
