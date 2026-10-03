import { reviewRoute } from "@/lib/reviews/routes.server";
import { queueReviewTest } from "@/lib/reviews/service.server";
export const POST = () => reviewRoute(queueReviewTest);
