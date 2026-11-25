"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatGiftExpiry } from "@/lib/gift/code";
import {
  body,
  bodyFaint,
  btnPrimary,
  btnSecondary,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";

type Preview = {
  to: string;
  code: string;
  offer: string;
  expiresAt: string | null;
  subject: string;
  html: string;
};

type Notice =
  | { kind: "error"; message: string }
  | { kind: "sent"; message: string }
  | { kind: "already_sent"; message: string };

const GENERIC_ERROR = "Something went wrong. Nothing was sent. Please try again.";

async function post(payload: Record<string, unknown>) {
  const response = await fetch("/api/admin/gift-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, data };
}

function messageFrom(data: Record<string, unknown> | null): string {
  return typeof data?.message === "string" ? data.message : GENERIC_ERROR;
}

/** The form on /admin/gift-codes: fill in, preview the exact email, send. */
export function GiftCodeSender() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const fields = { email: email.trim(), firstName: firstName.trim() || null, code: code.trim() };

  function edited() {
    // The preview must always match what would be sent.
    setPreview(null);
    setNotice(null);
  }

  async function onPreview(event: React.FormEvent) {
    event.preventDefault();
    setBusy("preview");
    setNotice(null);
    setPreview(null);
    try {
      const result = await post({ action: "preview", ...fields });
      if (result.ok && result.data?.preview) {
        setPreview(result.data.preview as Preview);
      } else {
        setNotice({ kind: "error", message: messageFrom(result.data) });
      }
    } catch {
      setNotice({ kind: "error", message: GENERIC_ERROR });
    } finally {
      setBusy(null);
    }
  }

  async function onSend(sendAgain: boolean) {
    setBusy("send");
    setNotice(null);
    try {
      const result = await post({ action: "send", ...fields, ...(sendAgain ? { sendAgain: true } : {}) });
      if (result.ok) {
        setNotice({ kind: "sent", message: `Sent to ${fields.email}.` });
        setPreview(null);
        setEmail("");
        setFirstName("");
        router.refresh();
      } else if (result.status === 409 && result.data?.error === "already_sent") {
        const when =
          typeof result.data.sentAt === "string"
            ? new Date(result.data.sentAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : null;
        setNotice({
          kind: "already_sent",
          message: `${fields.email} was already sent this code${when ? ` on ${when}` : ""}.`,
        });
      } else {
        setNotice({ kind: "error", message: messageFrom(result.data) });
      }
    } catch {
      setNotice({ kind: "error", message: GENERIC_ERROR });
    } finally {
      setBusy(null);
    }
  }

  const expiry = preview ? formatGiftExpiry(preview.expiresAt) : null;

  return (
    <div className="space-y-6">
      <form onSubmit={onPreview} className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="gift-email" className={fieldLabel}>Their email</label>
          <input
            id="gift-email" type="email" required autoComplete="off" value={email}
            onChange={(event) => { setEmail(event.target.value); edited(); }}
            className={inputField} placeholder="rosa@example.com"
          />
        </div>
        <div>
          <label htmlFor="gift-first-name" className={fieldLabel}>
            First name <span className={`font-normal ${bodyFaint}`}>(optional)</span>
          </label>
          <input
            id="gift-first-name" type="text" maxLength={60} autoComplete="off" value={firstName}
            onChange={(event) => { setFirstName(event.target.value); edited(); }}
            className={inputField} placeholder="Rosa"
          />
        </div>
        <div>
          <label htmlFor="gift-code" className={fieldLabel}>Stripe promotion code</label>
          <input
            id="gift-code" type="text" required minLength={3} maxLength={64} autoComplete="off"
            autoCapitalize="characters" spellCheck={false} value={code}
            onChange={(event) => { setCode(event.target.value); edited(); }}
            className={`${inputField} font-mono`} placeholder="FREEMONTH"
          />
        </div>
        <div className="sm:col-span-3">
          <button type="submit" disabled={busy !== null} className={`${btnSecondary} disabled:opacity-50`}>
            {busy === "preview" ? "Checking the code…" : "Preview email"}
          </button>
          <p className={`mt-2 text-xs ${bodyFaint}`}>
            Preview checks the code with Stripe and shows the exact email. Nothing is sent until you press Send.
          </p>
        </div>
      </form>

      {notice ? (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-2xl px-4 py-3 text-sm ${
            notice.kind === "sent" ? statusSuccess : notice.kind === "already_sent" ? statusWarning : statusDanger
          }`}
        >
          <p>{notice.message}</p>
          {notice.kind === "already_sent" ? (
            <button
              type="button" disabled={busy !== null} onClick={() => onSend(true)}
              className="mt-2 font-semibold underline underline-offset-2 disabled:opacity-50"
            >
              {busy === "send" ? "Sending…" : "Send it again anyway"}
            </button>
          ) : null}
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-4" data-gift-preview="">
          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <p className={body}><span className={bodyFaint}>To:</span> <strong className={ink}>{preview.to}</strong></p>
            <p className={body}><span className={bodyFaint}>Subject:</span> <strong className={ink}>{preview.subject}</strong></p>
            <p className={body}>
              <span className={bodyFaint}>Stripe says this code gives:</span>{" "}
              <strong className={ink}>{preview.offer}</strong>
            </p>
            <p className={body}>
              <span className={bodyFaint}>Expires:</span>{" "}
              <strong className={ink}>{expiry ?? "no end date"}</strong>
            </p>
          </div>

          {/* sandbox with no allowances: the preview can run nothing and reach nothing. */}
          <iframe
            title="Email preview" sandbox="" srcDoc={preview.html}
            className="h-[720px] w-full rounded-2xl border border-[#ece4d8] bg-white dark:border-white/[0.12]"
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button" disabled={busy !== null} onClick={() => onSend(false)}
              className={`${btnPrimary} disabled:opacity-50`}
            >
              {busy === "send" ? "Sending…" : `Send to ${preview.to}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
