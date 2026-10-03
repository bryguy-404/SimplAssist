import { publicReviewId, reviewPublicPage } from "@/lib/reviews/public.server";
import { reviewRpc } from "@/lib/reviews/service.server";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
) {
  if (!publicReviewId(params.token, "unsubscribe"))
    return reviewPublicPage(
      "Link unavailable",
      "This unsubscribe link is not valid.",
    );
  // Mail scanners follow GET links. Only a confirmation or RFC8058 POST mutates.
  return reviewPublicPage(
    "Unsubscribe from review requests",
    "Confirm to stop review request emails from this business.",
    "Unsubscribe",
  );
}
export async function POST(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const id = publicReviewId(params.token, "unsubscribe");
  if (!id) return new Response("Invalid link", { status: 400 });
  try {
    await reviewRpc("review_unsubscribe", { p_id: id });
    return reviewPublicPage(
      "You’re unsubscribed",
      "You will no longer receive review request emails from this business.",
    );
  } catch {
    return new Response("Please try again.", { status: 503 });
  }
}
