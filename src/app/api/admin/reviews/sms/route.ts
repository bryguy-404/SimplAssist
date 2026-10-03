import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminUser } from "@/lib/admin/auth";
import { approveExistingReviewSmsUsecase } from "@/lib/reviews/smsProvisioning.server";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
const requestSchema = z
  .object({
    businessId: z.string().uuid(),
    evidence: z.string().trim().min(20).max(2000),
    grantExpiresAt: z.string().datetime().optional(),
  })
  .strict();
export async function POST(request: Request) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const raw = await request.text();
    if (raw.length > 5000)
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    await approveExistingReviewSmsUsecase(
      parsed.data.businessId,
      admin.id,
      parsed.data.evidence,
      parsed.data.grantExpiresAt,
    );
    return NextResponse.json({ approved: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ReviewSmsError
            ? error.code
            : "review_sms_approval_failed",
      },
      { status: error instanceof ReviewSmsError ? error.status : 503 },
    );
  }
}
