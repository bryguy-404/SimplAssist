import Link from "next/link";
import { headers } from "next/headers";
import { getRequestBrand } from "@/lib/branding/requestBrand.server";
import { resolveStrictAuthCallbackOrigin } from "@/lib/auth/callbackOrigin.server";
import { giftCodeFromCookieHeader } from "@/lib/gift/code";
import { body, ink, inlineLink } from "@/lib/theme-v2/theme";
import PublicSignupForm from "./PublicSignupForm";

export default async function SignupPage() {
  let hostIdentity: Awaited<
    ReturnType<typeof resolveStrictAuthCallbackOrigin>
  > = null;

  try {
    hostIdentity = await resolveStrictAuthCallbackOrigin(headers().get("host"));
  } catch {
    // Only an explicit direct-host result may render public account creation.
  }

  if (hostIdentity?.kind === "direct") {
    // Set by the coupon email's start button. Absent for everyone else, in
    // which case signup is exactly what it has always been.
    const giftCode = giftCodeFromCookieHeader(headers().get("cookie"));
    return giftCode ? <PublicSignupForm giftCode={giftCode} /> : <PublicSignupForm />;
  }

  let brandName: string | null = null;
  if (hostIdentity?.kind === "partner") {
    try {
      const requestBrand = await getRequestBrand();
      if (
        requestBrand.source === "partner_host" &&
        requestBrand.brand.partnerId === hostIdentity.partnerId
      ) {
        brandName = requestBrand.brand.name;
      }
    } catch {
      // Branding is optional presentation; the strict host gate remains closed.
    }
  }

  return <InvitationOnlyAccess brandName={brandName} />;
}

function InvitationOnlyAccess({ brandName }: { brandName: string | null }) {
  return (
    <div className="text-center">
      <h1 className={`text-2xl font-bold tracking-tight ${ink}`}>
        Account creation is by invitation
      </h1>
      <p className={`mt-3 text-sm leading-6 ${body}`}>
        Contact your provider to request access.
      </p>
      <p className={`mt-7 text-sm ${body}`}>
        Already have access?{" "}
        <Link href="/login" className={inlineLink}>
          {brandName ? `Log in to ${brandName}` : "Log in"}
        </Link>
      </p>
    </div>
  );
}
