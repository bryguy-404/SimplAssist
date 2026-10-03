import "server-only";
import {
  escapeHtml,
  verifyReviewToken,
  type ReviewTokenPurpose,
} from "./domain";
export function publicReviewId(token: string, purpose: ReviewTokenPurpose) {
  try {
    return verifyReviewToken(token, purpose);
  } catch {
    return null;
  }
}
export function reviewPublicPage(
  title: string,
  message: string,
  button?: string,
) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:1.5rem"><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${button ? `<form method="post"><button type="submit" style="padding:.75rem 1rem">${escapeHtml(button)}</button></form>` : ""}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}
