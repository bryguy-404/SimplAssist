import { reviewRoute, reviewRequestBody } from "@/lib/reviews/routes.server";
import {
  confirmReviewCampaign,
  listReviewCampaigns,
} from "@/lib/reviews/service.server";
export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
  reviewRoute((businessId) => {
    const query = new URL(request.url).searchParams;
    return listReviewCampaigns(
      businessId,
      Number(query.get("page") ?? 1),
      Number(query.get("pageSize") ?? 10),
    );
  });
export const POST = (request: Request) =>
  reviewRoute(async (businessId, ownerId) =>
    confirmReviewCampaign(
      businessId,
      ownerId,
      (await reviewRequestBody(request)).previewToken,
    ),
  );
