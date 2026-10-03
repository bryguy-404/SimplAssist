import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import {
  reviewOverview,
  updateReviewSettings,
} from "@/lib/reviews/service.server";
export const dynamic = "force-dynamic";
export const GET = () => reviewRoute(reviewOverview);
export const PATCH = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    updateReviewSettings(businessId, ownerId, await reviewRequestBody(request)),
  );
