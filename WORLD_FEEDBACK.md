# World ID Selfie Check — integration feedback

Feedback from integrating Selfie Check into Tessera, a pay-per-call API
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
[`src/lib/world-credentials.ts`](src/lib/world-credentials.ts) ·
[`src/app/onboarding/selfie-check.tsx`](src/app/onboarding/selfie-check.tsx) ·
[`src/app/api/services/create/route.ts`](src/app/api/services/create/route.ts) ·
[`scripts/world-preflight.mjs`](scripts/world-preflight.mjs)

---

## Status of our testing — please read first

**Selfie Check itself is access-gated and was never enabled for our app**, so
we could not capture a Selfie Check proof. We would rather say that plainly
than imply a green run we did not have.

What *is* implemented and live:

- The full v4 path — server-signed `rp_context`, capture in World App, the
  proof forwarded verbatim to `/api/v4/verify/{rp_id}`, and only World's
  answer trusted. The client never asserts its own success.
- **Which credential the gate demands is configuration, not code**
  (`WORLD_CREDENTIAL`). Every ungated credential — Orb, Proof of Human,
  Document, Secure Document, Passport, Device — runs through the identical
  code path and produces a real nullifier. We built it this way precisely
  because an integration that only works once someone answers an email is an
  integration that cannot be demonstrated. Switching to Selfie Check the day
  it is enabled is one environment variable and no code change.
- A **downgrade guard**: World reports which credential actually satisfied a
  proof, and we refuse any identifier we did not ask for. Without it, a
  device-level proof could be recorded against a seller as a Selfie Check
  pass. We could find no documentation suggesting integrators should check
  this, and we think it deserves a warning on the verify reference — the field
  is right there in the response and it is easy to ignore.
- The seller gate itself: an unverified account is refused a listing, and the
  one-human-one-account rule is enforced by a `UNIQUE` constraint on the
  nullifier rather than by a heuristic.

`WORLD_SIMULATION=1` remains as a fallback for a clone with no World
credentials at all. It records the credential as `selfie_check_simulated`,
never as a real one; the UI labels every such seller as simulated; and
`/api/health` reports it. A valid configuration always beats it — the live
path takes over even if the flag is still set, because a deployment that can
prove humans should never quietly keep pretending to. It is not a World ID
proof and we are not presenting it as one.

---

## 1. Getting to a working configuration

Before any of the SDK observations below, the single hardest part of this
integration was working out *why* it did not work. Four separate things must
be true before a capture can succeed, and the failure of any one of them is
invisible until a person is standing in front of a camera:

1. The app exists in the Developer Portal.
2. The action exists under it.
3. The app has been migrated to World ID 4.0.
4. The credential is enabled for the app.

**Nothing surfaces which of the four is missing.** We had an `app_id` and an
`rp_id` in hand and assumed we were one signing key away from working. We were
not — the app had never been migrated, and the v4 verify endpoint answers every
proof from an unmigrated app with `app_not_migrated`. There is no indication of
this state anywhere a developer looks while integrating: the portal shows the
app, IDKit accepts the configuration, and the code runs. The error only appears
after a real human has completed a real capture, which is the most expensive
possible moment to discover a configuration problem.

We ended up writing a preflight script that diagnoses all four by probing
World's own endpoints with deliberately invalid proofs and reading which error
comes back — `invalid_action` means the app resolved but the action did not,
`app_not_migrated` means the migration was never done, and anything else means
both resolved. That works, but it is reverse-engineering error codes to
recover information the Developer Portal already has and does not show.

**What would fix this:** a readiness panel on the app page listing those four
preconditions with a tick or a cross against each, and a "test configuration"
button that runs the same probes server-side. Every one of these facts is
already known to World. Surfacing them would have saved us most of a day, and
would save every subsequent integrator the same day.

**Three World sources disagree about `environment`, and only one is right.**
The IDKit integration guide says the field accepts *"production"* and
*"staging"* and that staging is *"for testing with the simulator"*. The v4
verify API reference lists the enum as `production | staging`. The Sandbox
guide says to *"set `environment: sandbox`"*. The shipped TypeScript type
allows all three. We resolved it by posting a deliberate typo to the verify
endpoint, which answered:

> `environment must be one of the following values: production, staging, sandbox`

So `sandbox` is correct and two documentation pages are stale. A developer
following the IDKit guide — the page you would naturally read first — would
configure `staging` and never reach the Sandbox App at all. Reconciling those
three pages is a small edit with a large payoff.

**The signing key is shown once, with no warning that it is.** It is issued
during the 4.0 migration alongside the `rp_id`. If you close that screen — or
if someone else on the team completed the migration — the key is simply gone,
and nothing in the portal explains how to rotate or re-issue it. A one-line
"you will not see this again" and a visible rotate control would be enough.

---

## 2. Selfie Check docs and integration flow

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

## 3. Developer Portal — navigation, search, discovery, debugging

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

## 4. Sandbox App — states, proof flows, test users, edge cases

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

## 5. What was confusing, missing, broken, or hard to test

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

- Feature gating with no self-serve path is the blocker. Everything else here
  is a docs problem; this one stops evaluation outright. We ended up building a
  simulation harness purely to keep working, which is a signal in itself: when
  the fastest path to a working integration is to stub the provider out, the
  onboarding funnel has a gap. For hackathons especially,
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
