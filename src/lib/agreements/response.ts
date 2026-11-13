import { NextResponse } from "next/server";
import { ServiceAgreementError } from "./errors";

export function serviceAgreementFailure(error: unknown) {
  const problem = error instanceof ServiceAgreementError ? error : new ServiceAgreementError("service_agreement_unavailable");
  return NextResponse.json({ error: problem.code, code: problem.code, message: problem.message }, { status: problem.status, headers: { "Cache-Control": "no-store" } });
}
