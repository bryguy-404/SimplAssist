/**
 * The legal line on emails SimplAssist sends to customers as itself.
 *
 * SimplAssist is operated by Arambula Ventures LLC, and the company is named
 * in contracts and correspondence. The wording matches the website footer
 * ("SimplAssist, a product of Arambula Ventures LLC."), the Terms and the
 * Privacy Policy; change it here to change every email at once.
 *
 * Never added to partner-branded (white-label) emails, which must not name
 * SimplAssist, or to internal notifications that only Bryan receives.
 *
 * Pure: no "server-only", so templates and tests can import it.
 */
export const SIMPLASSIST_LEGAL_LINE =
  "SimplAssist is a product of Arambula Ventures LLC.";

/** A small grey closing paragraph for HTML emails. */
export const SIMPLASSIST_LEGAL_LINE_HTML =
  `<p style="font-size:12px;line-height:1.5;color:#78716c;">${SIMPLASSIST_LEGAL_LINE}</p>`;

/** Appends the line to whichever of `text` and `html` a message has. */
export function appendLegalFooter<
  T extends { text?: unknown; html?: unknown },
>(message: T): T {
  return {
    ...message,
    ...(typeof message.text === "string"
      ? { text: `${message.text}\n\n${SIMPLASSIST_LEGAL_LINE}` }
      : {}),
    ...(typeof message.html === "string"
      ? { html: `${message.html}${SIMPLASSIST_LEGAL_LINE_HTML}` }
      : {}),
  };
}
