"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Frown, Meh, MessageSquareText, Smile, X } from "lucide-react";
import { useBrand } from "@/components/branding/BrandProvider";
import { feedbackAction, feedbackRatings, type FeedbackRating } from "@/lib/feedback/client";
import { accentText, body, btnPrimaryInline, ink } from "@/lib/theme-v2/theme";

const faces = { Great: Smile, Okay: Meh, Frustrating: Frown };
type Invitation = { id: string; automatic: boolean };

function FeedbackCard({ invitation, close }: { invitation: Invitation; close: () => void }) {
  const brand = useBrand();
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!invitation.automatic) title.current?.focus();
  }, [invitation.automatic]);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(close, 3500);
    return () => window.clearTimeout(timer);
  }, [sent, close]);

  async function dismiss() {
    if (submitting.current) return;
    if (sent || !invitation.automatic) { close(); return; }
    submitting.current = true;
    setBusy(true);
    try {
      await feedbackAction({ action: "dismiss", id: invitation.id });
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
      await feedbackAction({ action: "submit", rating, comment, id: invitation.id });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section id="dashboard-feedback" aria-label="Product feedback"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); void dismiss(); } }}
      className="fixed bottom-3 right-3 z-30 w-[calc(100%-1.5rem)] max-w-[23rem] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-[22px] border border-[#e6ddcf] bg-white p-5 shadow-[0_12px_48px_rgba(68,45,24,0.16)] sm:bottom-6 sm:right-6 sm:p-6 dark:border-white/15 dark:bg-[#1c1c1f]">
      <div className="flex items-center justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--brand-accent-soft)] dark:bg-white/10 ${accentText}`}>
          {sent ? <Check size={19} /> : <MessageSquareText size={19} />}
        </span>
        <button type="button" onClick={() => void dismiss()} disabled={busy} aria-label="Close feedback"
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10">
          <X size={17} />
        </button>
      </div>
      {sent ? <p role="status" className={`mt-4 text-lg font-semibold ${ink}`}>Thanks for sharing your feedback!</p> : (
        <form onSubmit={submit}>
          <h2 id="feedback-question" ref={title} tabIndex={-1} className={`mt-3 max-w-[19rem] text-[23px] font-bold leading-tight tracking-tight outline-none ${ink}`}>
            How’s {brand.name} working for you so far?
          </h2>
          <p className={`mt-1.5 text-sm ${body}`}>We’d love to hear what’s working and what we could do better.</p>
          <fieldset aria-labelledby="feedback-question" disabled={busy} className="mt-4 grid grid-cols-3 gap-2">
            {feedbackRatings.map((value) => {
              const Face = faces[value];
              return (
                <label key={value} className="cursor-pointer">
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
          <textarea id="feedback-comment" value={comment} onChange={(event) => setComment(event.target.value)}
            maxLength={1500} disabled={busy} rows={2}
            className={`mt-1.5 block w-full resize-y rounded-xl border border-stone-300 bg-transparent px-3 py-2 text-sm focus:outline-[var(--brand-accent)] dark:border-white/20 ${ink}`} />
          {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button type="button" onClick={() => void dismiss()} disabled={busy} className={`py-2 text-sm hover:underline ${body}`}>
              {invitation.automatic ? "Maybe later" : "Cancel"}
            </button>
            <button type="submit" disabled={!rating || busy} className={`${btnPrimaryInline} disabled:cursor-not-allowed disabled:opacity-50`}>
              {busy ? "Saving…" : "Send feedback"}
            </button>
          </div>
        </form>
      )}
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
