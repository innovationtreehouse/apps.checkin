# Sequencing the target security architecture

**Status: PROPOSED. The build/migration order for
[TARGET_SECURITY_ARCHITECTURE.md](TARGET_SECURITY_ARCHITECTURE.md). That
document is the design; this one is only the order of operations, kept
separate so the strategy stays free of plan detail.**

Ordered so every step is independently shippable and the test floor arrives
before the construction ceiling:

1. **Decide the design's open issues**; several change what gets built.
2. **Vocabulary PRs**, registry/schema-only, boundary-isolation
   compliant: graduate leak-critical business rules to scopes
   (`org_members` first), split the **`deliberative` tier** out of
   `internal`, and land the **declared field withholds** for the routes
   whose hand-written selects are the only control today (see "The tier
   split" in the design). These share a hard deadline: each must merge
   before step 5 reaches its routes, because the generated select is what
   replaces the hand-written one protecting those fields today. (One
   boundary PR may batch multiple registry entries;
   `security-boundary-isolation.yml` checks companionship, not
   cardinality, so no separate batch lane is needed.)
3. **Persona row-contract walker** (#1134 Step 1) with ceiling semantics
   over registered GET routes; convert `EDGE_INCLUDE_ALLOWLIST` prose to
   `rows:` declarations as routes gain them. The **governance report
   generator** ships here in its first honest form: the data-subject
   pivot over whatever declarations exist, per-sentence attestation marks
   that *fail generation only for routes the walker already covers*
   (the gate tightens as coverage grows rather than failing on day one),
   and ungoverned doors enumerated from the wrapper scan (the
   `asSystem()` inventory section appears in step 5 when the facade
   exists). The report-diff-in-declaration-PRs rule takes effect from
   this step forward.
4. **`rowsWhere` + property-based equivalence** (#1134 Step 2, with the
   in-thread fail-closed requirements): the first half of the compiler,
   not an optional ergonomic.
5. **Select generation + the scoped facade**: the second half. New and
   migrating routes get `db` instead of raw prisma; strip-tripwire
   telemetry and the `asSystem()` inventory land with it. The facade's
   equivalence tests must include the `where`-composition collision cases
   the design pins (key shadowing on spread, empty fragments; "wrap,
   never spread").
6. **Registry conversion as a tracked program: one hop, all of
   `withAuth`.** The endgame is decided in the design: every `withAuth`
   route migrates (reads first), each **once, directly to the facade
   form**, not `withAuth` → bare `handler()` → facade in two passes.
   Bulk conversion *waits for step 5*, then proceeds as one wave per
   route; the routes already on `handler()` pick up the facade as part
   of that wave. The census (design, "What exists"): 116 `withAuth`
   caller files, 123 distinct session-authenticated files, 7
   dual-wrapper files that migrate per-verb. Constraints carried from
   the design: **computed-envelope routes migrate only after their
   fields exist in the projection catalog** (the `derive`-hook DECISION
   RECORD in `auth-consistency-analysis.md` stays binding until then),
   and the non-session wrappers plus the hand-rolled
   `GET /api/attendance` are excluded; their treatment is designed in
   "Surfaces without a session caller", with `/api/attendance`
   converting deliberately alongside the kiosk-principal declaration,
   never in the bulk wave.
7. **Outbound adoption**: route production mail through `outboundCall`
   (today it has zero production call sites), then add the recipient
   declaration and enforce the recipient-scope rule. This step exists so
   the design's "largest uncontrolled disclosure channel" has an owner
   and a date, not an adjective.
8. **Walker extended to writes** (I4).
9. **RLS pilot** on the highest-sensitivity tables, if adopted (design
   open issue 1, decided jointly with the portfolio; requires the
   system-reader design the open issue names).
