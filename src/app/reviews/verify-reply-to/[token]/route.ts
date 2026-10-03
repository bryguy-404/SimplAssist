import { publicReviewId, reviewPublicPage } from "@/lib/reviews/public.server";
import { reviewRpc } from "@/lib/reviews/service.server";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
) {
  if (!publicReviewId(params.token, "reply_to"))
    return reviewPublicPage(
      "Link unavailable",
      "This confirmation link is not valid.",
    );
  return reviewPublicPage(
    "Confirm your Reply-To email",
    "Confirm that you want replies to this business’s review requests to arrive at this address.",
    "Confirm email address",
  );
}
export async function POST(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const id = publicReviewId(params.token, "reply_to");
  if (!id) return new Response("Invalid link", { status: 400 });
  try {
    const confirmed = await reviewRpc<boolean>("review_confirm_reply_to", {
      p_id: id,
    });
    return confirmed
      ? reviewPublicPage(
          "Email confirmed",
          "This address is now the verified Reply-To for your review requests.",
        )
      : reviewPublicPage(
          "Link unavailable",
          "This link has expired, was already used, or was replaced by a newer request.",
        );
  } catch {
    return new Response("Please try again.", { status: 503 });
  }
}
