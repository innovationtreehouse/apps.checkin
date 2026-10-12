# Domain rules register

One file per domain. Read the file for the area you are changing before you
change behaviour in it.

Sections, tagging, citation, and what counts as a divergence are defined by
`docs/DOCUMENTATION_STANDARD.md` §3. This file does not restate them.

## Where these came from

Two independent sources, neither able to see the other:

- **The pull-request history**, showing what shipped, read alongside the policy
  corpus, showing what the board decided.
- **Session transcripts**, showing what was said — including decisions that
  produced no diff, and roads deliberately not taken.

Both were checked against the current tree before anything was written down.
Where a source described an intention as though it had shipped, the code won, so
several rules here are narrower than the discussion that produced them.

## Divergences

Where the app implements a board rule more loosely than the policy states, that
is stated **on the rule it qualifies** — not collected into a section of its own.
A reader who finds their answer stops reading, so a rule qualified somewhere else
is read as unqualified.

It is also tracked as work, because a divergence from board policy is not
something a domain file can resolve by describing it. Recording one is therefore
not the end of it, and it is not a feature request either: what closes it is the
policy, not a judgement about what is worth building.

A gap the app does not model at all is not a divergence — there is no rule to
qualify, and it belongs to the tracker alone. See `docs/DOCUMENTATION_STANDARD.md`
§3.7 for the full test.

## Files

| File | Covers |
|---|---|
| `principles.md` | rules holding across every domain — the middle tier |
| `membership.md` | application, review, activation, fees, renewal |
| `people-households.md` | households, leads, identity, age, emergency contacts, trusted adults |
| `programs.md` | eligibility, enrollment, pricing, capacity, scholarships |
| `finance-payments.md` | fees, refunds, payment plans, reconciliation |
| `attendance-checkin.md` | opening and closing, supervision, the kiosk, visits |
| `tools-certification.md` | certification levels, who may certify, shop access |
| `inventory.md` | the shared catalog (what parts, tools, and consumables are) and, as it lands, on-hand holdings |

Two registers sit outside this directory and are not duplicated here:
`checkin-app/docs/VOCABULARY.md` defines what the words mean, and
`docs/conventions.md` holds how we build rather than what the domain requires.
