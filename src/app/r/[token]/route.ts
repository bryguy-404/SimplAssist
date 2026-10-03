import { supabaseAdmin } from "@/lib/supabase/admin";
import { publicReviewId, reviewPublicPage } from "@/lib/reviews/public.server";
import { validateGoogleReviewUrl } from "@/lib/reviews/domain";
import { reviewRpc } from "@/lib/reviews/service.server";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const id = publicReviewId(params.token, "review");
  if (!id)
    return reviewPublicPage(
      "Link unavailable",
      "This review link is not valid.",
    );
  const { data, error } = await supabaseAdmin
    .from("review_enrollments")
    .select("google_review_url")
    .eq("id", id)
    .maybeSingle();
  const target = data ? validateGoogleReviewUrl(data.google_review_url) : null;
  if (error || !target)
    return reviewPublicPage(
      "Link unavailable",
      "This review link is no longer available.",
    );
  try {
    await reviewRpc("review_stop_enrollment", {
      p_id: id,
      p_reason: "clicked",
    });
  } catch {
    return new Response("Please try this link again.", { status: 503 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
