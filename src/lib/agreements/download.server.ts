import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { readServiceAgreement } from "./service.server";
import { ServiceAgreementError } from "./errors";
import { serviceAgreementFailure } from "./response";

function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export async function serviceAgreementDownload(businessId: string, agreementId: string, attachment: boolean) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agreementId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const record = await readServiceAgreement(businessId, agreementId);
    if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { agreement: a, document: d, references } = record;
    if (createHash("sha256").update(d.terms_html).digest("hex") !== d.terms_sha256) throw new ServiceAgreementError("service_agreement_unavailable");
    const rows = [
      ["Record", a.id], ["Business", a.business_name], ["Business ID", a.business_id],
      ["Subscriber", a.subscriber_email], ["Subscriber ID", a.subscriber_id],
      ["Acceptance recorded (UTC)", new Date(a.accepted_at).toISOString()],
      ["Submitted from", a.source], ["Terms version", a.terms_version],
      ["Checkbox wording", d.checkbox_text], ["Terms link shown", d.terms_url], ["Privacy link shown", d.privacy_url],
      ["Archived Terms SHA-256", d.terms_sha256],
      ...references.map((reference) => [reference.kind, reference.reference]),
    ];
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimplAssist service agreement</title><style>body{max-width:850px;margin:40px auto;padding:0 24px;font:16px/1.6 system-ui,sans-serif;color:#222}dt{font-weight:600}dd{margin:0 0 12px;overflow-wrap:anywhere}section{margin-top:30px}a{color:#9a3412}hr{margin:36px 0}@media print{body{margin:0;max-width:none}section{break-inside:auto}}</style></head><body><h1>Service agreement record</h1><p>Acceptance was recorded when the signed-in subscriber submitted the confirmation. This is not a timestamp of the checkbox click.</p><dl>${rows.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join("")}</dl><hr><p>The following is the preserved Terms text for this acceptance.</p>${d.terms_html}</body></html>`;
    return new NextResponse(html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="simplassist-agreement-${a.id}.html"`,
      "Cache-Control": "private, no-store", "Vary": "Cookie",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
    } });
  } catch (error) { return serviceAgreementFailure(error); }
}
