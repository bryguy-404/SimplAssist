"use client";

import { useEffect, useRef, useState } from "react";
import { Frown, Meh, MessageSquareText, Smile, X } from "lucide-react";
import { useBrand } from "@/components/branding/BrandProvider";
import { feedbackAction, feedbackRatings, type FeedbackRating } from "@/lib/feedback/client";
import { body, btnPrimaryInline, ink } from "@/lib/theme-v2/theme";
import { FeedbackDot, type DotScene } from "./FeedbackDot";

const faces = { Great: Smile, Okay: Meh, Frustrating: Frown };
type Invitation = { id: string; automatic: boolean };

// What the dot in the card's corner says. It is decoration: the card's own
// heading, labels and status text carry everything a customer needs.
const dotQuips: Record<FeedbackRating, string> = {
  Great: "Yes! Love that.",
  Okay: "Hmm, okay. Noted.",
  Frustrating: "Oof. Tell me more?",
};
const thanks: Record<FeedbackRating, string> = {
  Great: "You made the dot’s day. Thank you!",
  Okay: "Thank you! That’s how we get better.",
  Frustrating: "Thank you for being straight with us.",
};
// Long enough for the dot's send-off to finish and the thank-you to be read.
const SENT_CLOSE_MS = 4200;

export function FeedbackCard({ invitation, close, send = feedbackAction }: {
  invitation: Invitation;
  close: () => void;
  /** Swapped for a stand-in on the /demo/feedback review page. */
  send?: typeof feedbackAction;
}) {
  const brand = useBrand();
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  // These four only steer the dot.
  const [hovered, setHovered] = useState<FeedbackRating | null>(null);
  const [listening, setListening] = useState(false);
  const [eager, setEager] = useState(false);
  const [nod, setNod] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const confetti = useRef<HTMLCanvasElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!invitation.automatic) title.current?.focus();
  }, [invitation.automatic]);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(close, SENT_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [sent, close]);

  async function dismiss() {
    if (submitting.current) return;
    if (sent || !invitation.automatic) { close(); return; }
    submitting.current = true;
    setBusy(true);
    try {
      await send({ action: "dismiss", id: invitation.id });
      close();
    } catch {
      setError("Couldn’t save your preference. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!rating || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await send({ action: "submit", rating, comment, id: invitation.id });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  // A frustrated customer gets a quiet thank-you, not a party.
  const scene: DotScene = !sent ? "form" : rating === "Frustrating" ? "bow" : "cheer";
  const leaning = eager && !!rating && !busy;
  const quip = busy ? "One sec…"
    : error ? "Uh-oh."
    : leaning ? "Send it!"
    : hovered ? dotQuips[hovered]
    : listening ? (comment ? "Mm-hm, go on." : "I’m listening…")
    : rating ? dotQuips[rating]
    : "Psst… got a sec?";

  return (
    <section id="dashboard-feedback" aria-label="Product feedback"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); void dismiss(); } }}
      className="fixed bottom-3 right-3 z-30 w-[calc(100%-1.5rem)] max-w-[23rem] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-[22px] border border-[#e6ddcf] bg-white p-5 shadow-[0_12px_48px_rgba(68,45,24,0.16)] sm:bottom-6 sm:right-6 sm:p-6 dark:border-white/15 dark:bg-[#1c1c1f]">
      <div className="flex items-center justify-between">
        <FeedbackDot mood={hovered ?? rating ?? "idle"} scene={scene} eager={leaning}
          listening={listening} quip={quip} nod={nod} confetti={confetti} />
        <button type="button" onClick={() => void dismiss()} disabled={busy} aria-label="Close feedback"
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10">
          <X size={17} />
        </button>
      </div>
      {sent ? (
        // The top margin leaves room for the dot, which performs just above.
        <div className="mt-[52px] text-center">
          <p role="status" className={`text-lg font-semibold ${ink}`}>{thanks[rating ?? "Okay"]}</p>
          <p className={`mt-1 text-sm ${body}`}>Your note is on its way to our team.</p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <h2 id="feedback-question" ref={title} tabIndex={-1} className={`mt-3 max-w-[19rem] text-[23px] font-bold leading-tight tracking-tight outline-none ${ink}`}>
            How’s {brand.name} working for you so far?
          </h2>
          <p className={`mt-1.5 text-sm ${body}`}>Be honest, the dot can take it. Pick a face, hit send, and it’ll put on a little show.</p>
          <fieldset aria-labelledby="feedback-question" disabled={busy} className="mt-4 grid grid-cols-3 gap-2">
            {feedbackRatings.map((value) => {
              const Face = faces[value];
              return (
                <label key={value} className="cursor-pointer"
                  onPointerEnter={() => setHovered(value)} onPointerLeave={() => setHovered(null)}>
                  <input type="radio" name="feedback-rating" value={value} required checked={rating === value}
                    onChange={() => setRating(value)} className="peer sr-only" />
                  <span className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl border border-stone-200 py-2 text-xs font-semibold peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-checked:border-[var(--brand-accent)] peer-checked:bg-[var(--brand-accent-soft)] peer-checked:text-[var(--brand-accent)] hover:bg-stone-50 dark:border-white/15 dark:hover:bg-white/10 dark:peer-checked:bg-white/10 dark:peer-checked:text-[var(--brand-accent-dark)] ${body}`}>
                    <Face size={19} strokeWidth={1.7} aria-hidden="true" />{value}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <label className={`mt-4 block text-sm font-semibold ${ink}`} htmlFor="feedback-comment">
            What’s one thing we could make easier? <span className={`text-xs font-normal ${body}`}>(optional)</span>
          </label>
          <textarea id="feedback-comment" value={comment}
            onChange={(event) => { setComment(event.target.value); setNod((count) => count + 1); }}
            onFocus={() => setListening(true)} onBlur={() => setListening(false)}
            maxLength={1500} disabled={busy} rows={2}
            className={`mt-1.5 block w-full resize-y rounded-xl border border-stone-300 bg-transparent px-3 py-2 text-sm focus:outline-[var(--brand-accent)] dark:border-white/20 ${ink}`} />
          {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button type="button" onClick={() => void dismiss()} disabled={busy} className={`py-2 text-sm hover:underline ${body}`}>
              {invitation.automatic ? "Maybe later" : "Cancel"}
            </button>
            <button type="submit" disabled={!rating || busy}
              onPointerEnter={() => setEager(true)} onPointerLeave={() => setEager(false)}
              onFocus={() => setEager(true)} onBlur={() => setEager(false)}
              className={`${btnPrimaryInline} disabled:cursor-not-allowed disabled:opacity-50`}>
              {busy ? "Saving…" : "Send feedback"}
            </button>
          </div>
        </form>
      )}
      {/* The cheer's confetti is drawn here, so it stays inside the card. */}
      <canvas ref={confetti} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
    </section>
  );
}

export default function DashboardFeedback() {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visitId = useRef<string>();
  const interacted = useRef(false);

  useEffect(() => {
    let active = true;
    const id = visitId.current ??= crypto.randomUUID();
    void feedbackAction({ action: "visit", id }).then((result) => {
      if (active && !interacted.current && result === "show") setInvitation({ id, automatic: true });
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  function close() {
    if (document.activeElement?.closest("#dashboard-feedback") || !invitation?.automatic) trigger.current?.focus();
    setInvitation(null);
  }

  return (
    <>
      <button type="button" ref={trigger} aria-expanded={!!invitation}
        aria-controls={invitation ? "dashboard-feedback" : undefined}
        onClick={() => {
          interacted.current = true;
          if (invitation) document.getElementById("feedback-question")?.focus();
          else setInvitation({ id: crypto.randomUUID(), automatic: false });
        }}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium hover:bg-stone-100 dark:hover:bg-white/10 ${body}`}>
        <MessageSquareText size={16} /> Give feedback
      </button>
      {invitation && <FeedbackCard invitation={invitation} close={close} />}
    </>
  );
}
