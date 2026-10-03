import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import { reviewEnrollmentAction } from "@/lib/reviews/service.server";
export const POST = (
  request: Request,
  { params }: { params: { id: string } },
) =>
  reviewRoute(async (businessId, ownerId) =>
    reviewEnrollmentAction(
      businessId,
      ownerId,
      params.id,
      await reviewRequestBody(request),
    ),
  );
