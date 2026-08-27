# World ID Selfie Check — integration feedback

Feedback from integrating Selfie Check into Tollgate, a pay-per-call API
marketplace, during ETHOnline 2026.

**What we used it for.** Sellers must prove they are a distinct human before
they can list a paid service. Without that gate, one person registers as fifty
sellers, lists fifty cheap endpoints, collects payments and disappears. The
nullifier is stored under a `UNIQUE` constraint, so the second seller account
from the same human is rejected by the database rather than by a heuristic.
Selfie Check felt like the right assurance level: an Orb is disproportionate
for "prove you are a distinct person before taking payments", while a wallet
signature proves nothing at all.

Integration points:
[`src/lib/world.ts`](src/lib/world.ts) ·
[`src/app/onboarding/selfie-check.tsx`](src/app/onboarding/selfie-check.tsx) ·
[`src/app/api/services/create/route.ts`](src/app/api/services/create/route.ts)

---

## Status of our testing — please read first

**We could not complete an end-to-end Sandbox App run.** Selfie Check is
feature-gated, and both the credential page and the sandbox testing page say
access must be requested through a World point of contact. We have no way to
self-serve that during a hackathon weekend, so:

- The client integration, RP-context signing, proof forwarding and backend
  verification are all implemented against the documented v4 API and the
  shipped IDKit type definitions.
- Because the credential could not be enabled, we added a clearly-labelled
  simulation mode (`WORLD_SIMULATION=1`) so the rest of the product could be
  built and demonstrated. It records the credential as
  `selfie_check_simulated`, never as a real one; the UI labels every such
  seller as simulated; and `/api/health` reports `world_id: "simulated"`. It
  is not a Selfie Check and we are not presenting it as one. Removing the flag
  and setting the RP signing key switches to the real flow with no code change.
- The seller gate is implemented and tested: an unverified account is refused
  a listing, and the one-human-one-account constraint is enforced.
- The actual capture → proof → verify round trip through the Sandbox App is
  **untested by us**, because we could not get the credential enabled.

We would rather say that plainly than imply a green run we did not have. Every
observation below is about the docs, the SDK surface and the Developer Portal,
which we could reach.

---

## 1. Selfie Check docs and integration flow

**The credential page is a description, not an integration guide.**
`docs.world.org/world-id/credentials/11` explains what Selfie Check is and
mentions IDKit, but it contains no package name, no credential identifier, no
code sample, no verification endpoint and no payload shape. Everything needed
to actually write the integration had to be recovered from the shipped
TypeScript definitions in `@worldcoin/idkit-core`. A ten-line "here is the
minimum working integration" block would have removed most of a day.

**`selfieCheckLegacy` is a confusing name for the only option.** The export is
`selfieCheckLegacy`, the type is `SelfieCheckLegacyPreset`, and the doc comment
says *"This preset only returns World ID 3.0 proofs. Use it for compatibility
with older IDKit versions."* Reading that in isolation, the natural conclusion
is that it is deprecated and a non-legacy `selfieCheck` exists. It does not.
We nearly went looking for a v4 Selfie Check preset that was never there.
Either name it `selfieCheck`, or state explicitly on the credential page that
the legacy preset is the current and only way to request this credential.

**The v3/v4 split is a trap for this credential specifically.** Because
Selfie Check returns 3.0 proofs, `allow_legacy_proofs: true` is *mandatory*.
Set it to `false` — which the IDKit docs actively recommend for new apps
("Use after migration cutoff or for new apps") — and a brand-new integration
fails. The general advice and this credential's requirement point in opposite
directions, and nothing on the Selfie Check page warns about it. This deserves
a callout box.

**RP-context signing is undiscoverable from the credential docs.** Requests
now require a signed `rp_context`, produced with `signRequest` from
`@worldcoin/idkit-core/signing`, which re-exports from `@worldcoin/idkit-server`.
None of the credential documentation we read mentions this, yet no request can
be opened without it. We found it by reading `package.json` exports. The
security design is good — the RP key stays server-side — but it needs to be in
the first code sample a developer sees, not discovered by archaeology.

**`app_id` versus `rp_id` is never explained.** The verify endpoint is
`/api/v4/verify/{rp_id}`, and the reference notes that `app_id` is "accepted
for backward compatibility". Meanwhile `IDKitRequestConfig` requires
`app_id: \`app_${string}\`` *and* an `rp_context` carrying `rp_id`. So an
integration needs both identifiers, of different shapes, obtained separately,
with no page explaining their relationship or which one to use where. This was
the single most confusing part of the integration.

---

## 2. Developer Portal — navigation, search, discovery, debugging

**Product discovery is fine; credential discovery is not.** Finding World ID
is easy. Working out which credentials exist, which are generally available,
which are gated, and which require a support conversation is not surfaced
anywhere as a single list. A capability matrix — credential, assurance level,
availability, protocol version, preset name — would answer in one table what
currently takes several pages and a package inspection.

**Gating is discovered too late.** The requirement to contact
`developers@toolsforhumanity.com` appears as a note near the bottom of the
credential page and again in the sandbox guide. By the time a developer reads
either, they have usually already chosen the credential and started building.
A badge at the top of the page — "Preview · access required" — with the
request link would set expectations before any code is written.

**No debugging guidance for the failure cases we would actually hit.** IDKit
defines a rich `IDKitErrorCode` union (`credential_unavailable`,
`world_id_4_not_available`, `invalid_rp_signature`, `nullifier_replayed`,
`inclusion_proof_pending`, `max_verifications_reached`, and more). We could
find no page that says what each means, whether it is retryable, and what the
integrator should show the user. For an integration whose whole purpose is
gating access, "what do I do when verification fails?" is the central
question, and it is unanswered. Publishing that table would be the single
highest-value docs addition.

**Verify API error codes are similarly thin.** `app_not_migrated`,
`all_verifications_failed` and `verification_error` are listed without
guidance on cause or remedy. `all_verifications_failed` in particular could be
a bad proof, an expired nonce, a wrong action, or a mismatched RP — all of
which want different fixes.

---

## 3. Sandbox App — states, proof flows, test users, edge cases

We could not exercise these, so this section is about the documentation of the
sandbox rather than the sandbox itself.

**The hot / cold / semi-cold framing is genuinely good.** Naming the three
device states and describing each funnel is more thoughtful than most sandbox
documentation, and it made it obvious which paths we would need to test.

**The page is missing everything needed to start.** There is no sandbox base
URL, no `app_id` format for sandbox apps, no test-user list, no sample proof
payload, and no worked example. `IDKitRequestConfig` has an
`environment: "production" | "staging" | "sandbox"` field which is presumably
central to sandbox testing, but the sandbox page does not mention it. We set
`WORLD_ENVIRONMENT=sandbox` and pass it through by inference from the type
definition, not from any documentation.

**Distribution is a real friction point.** Access via TestFlight and private
Play links means every teammate and every judge needs individual provisioning.
For a hackathon, where a judge may want to reproduce the flow themselves, that
is close to prohibitive. A hosted web sandbox that returns well-formed mock
proofs — clearly marked as non-production — would let integrators verify their
plumbing end to end without any device provisioning at all. That single
addition would have unblocked us completely.

**No documented way to test the failure branches.** We wanted to verify our
handling of a rejected check, a replayed nullifier and an expired nonce. There
is no described mechanism for forcing those outcomes, so the error paths in our
integration are written from the type definitions and remain unexercised.

---

## 4. What was confusing, missing, broken, or hard to test

**Confusing**

- `selfieCheckLegacy` naming versus its "legacy/compatibility" doc comment.
- Needing both `app_id` and `rp_id`, with no page explaining the relationship.
- General guidance to prefer `allow_legacy_proofs: false` while this
  credential requires `true`.

**Missing**

- Any code sample on the Selfie Check credential page.
- The credential identifier and verify payload shape in prose form.
- Mention of `rp_context` / `signRequest` in the credential documentation.
- A meaning-and-remedy table for `IDKitErrorCode` and verify API error codes.
- Sandbox `app_id` format, environment flag, test users and sample payloads.

**Broken**

- Nothing broken in the SDK. The published TypeScript types are accurate,
  complete and well commented — they were, in practice, better documentation
  than the documentation. If the doc site rendered these types with their doc
  comments, most of this feedback would evaporate.

**Hard to test**

- Feature gating with no self-serve path is the blocker. We ended up building
  a simulation harness purely to keep working, which is a signal in itself:
  when the fastest path to a working integration is to stub the provider out,
  the onboarding funnel has a gap.
- Feature gating with no self-serve path is the blocker. Everything else is a
  docs problem; this one stops evaluation outright. For hackathons especially,
  consider a time-boxed self-serve sandbox enablement — even rate-limited to a
  handful of verifications per day — so a team can determine whether the
  credential fits before committing to it.

---

## What worked well

- The TypeScript definitions are excellent: precise unions, useful doc
  comments, and the `Preset` model composes cleanly.
- Server-side RP signing is the right security design, and `signRequest` has a
  small, obvious API.
- Returning a stable nullifier makes the sybil-resistance use case trivial to
  implement correctly — a `UNIQUE` constraint is the entire enforcement
  mechanism, which is exactly as much code as that should take.
- The three-state device framing in the sandbox docs is a genuinely good model
  that other providers should copy.
