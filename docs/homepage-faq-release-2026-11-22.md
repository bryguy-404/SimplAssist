# Homepage FAQ additions — November 22, 2026

## Status: held for a coordinated release

Bryan approved the two answers below, asked to retain every existing homepage
FAQ, and authorized deployment. After learning that the chat **Add bulk spam call
management** was active in the same workspace, he asked that its feature work not
be interrupted and permitted holding this separate release and prompting that
chat to coordinate. The FAQ chat is handing off the completed source change for
inclusion in the next approved web release. This handoff does not itself approve
deployment of the call-screening feature or any database/provider changes.

## Completed source change

Only `src/app/(public)/home/seo.ts` changes application behavior: two entries were
appended to `VOICE_FAQS`, which is included in both homepage variants and their
FAQ JSON-LD. Existing questions and answers were preserved.

- Can I keep my existing phone number and have SimplAssist answer calls I miss?
- Can I keep using my existing website's quote form or booking process?

The source file in the shared workspace contains the approved final answers.
Include that file when preparing the combined release. Do not replace a newer
application release with the standalone FAQ archive described below.

## Verification and attempted release

- All 12 existing tests in `src/app/(public)/home/page.test.tsx` passed, both in
  the workspace and in the isolated release directory. They verify rendered
  FAQs, disclosure markup, and matching FAQ structured data for both variants.
- `git diff --check` passed for the FAQ source file.
- Before deployment, the live homepage had 11 FAQs. Its complete FAQ JSON-LD was
  saved to `/private/tmp/simplassist-faq-before.json` for preservation checks.
- Production baseline: web deployment
  `dff2f72c-943b-4a62-bfaf-c8a5f031482b`, the already-released bulk inbox deletion
  version. Its source archive was verified against recorded SHA-256
  `836c1615d9873ce3622242b4098a598fe4ef395d569fbf20b90327ce892acf7b`.
- Attempt `cbacd1c1-e733-4a8f-ba48-66424816a395` failed before application build
  or cutover. Python extraction had materialized the Mac AppleDouble entries
  in the baseline tarball; Nixpacks tried to parse `._next.config.test.ts` as
  UTF-8. This was an archive-packaging failure, not a failed application test.
- The temporary release was cleaned of all `._*` metadata. Byte comparisons of
  the 1,618 remaining files show only `src/app/(public)/home/seo.ts` differs from
  the production baseline. No credentials, dependencies, or build output were
  included. No retry was submitted because the release is now coordinated with
  the other chat.
- Clean temporary archive: `/private/tmp/simplassist-faq-release-clean.tar.gz`.
  SHA-256: `a4e4a68c12b6ea6b2a5fbfef13a8f5601ce8c129dc34052ed73822ab23daf938`.
  Manifest: `/private/tmp/simplassist-faq-release-manifest.json`.
- Railway confirmed the attempt as `FAILED` and the prior deployment as
  `SUCCESS`. The live `/api/health` endpoint subsequently returned HTTP 200.
  This chat changed no environment variables, workers, provider settings,
  migrations, or production data.

## Remaining acceptance after the combined deployment

Verify the new deployment succeeds and the live homepage shows both approved
questions and full answers. Compare all 11 original FAQ questions and answers
with the saved baseline, and verify the live FAQ JSON-LD has the same 13 entries
as the page. Check both new disclosures in the browser. Preserve any other
separately approved feature changes included by the release-owning chat.
