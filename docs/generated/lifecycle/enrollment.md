<!-- GENERATED — do not edit by hand.
     Source: the machine module’s exported TRANSITIONS, via src/lib/lifecycle/machineSpecs.ts.
     Regenerate: npm run generate:lifecycle-artifacts
     Drift-checked by src/lib/lifecycle/__tests__/artifactsDrift.test.ts. -->

# ProgramParticipant enrollment — lifecycle artifacts

Generated from the machine’s `TRANSITIONS`. Do not hand-edit.

## State diagram

```mermaid
stateDiagram-v2
    ACTIVE --> WITHDRAWN: T12 withdraw
    ACTIVE --> [*]: T10 refund restocked
    ACTIVE --> [*]: T11 remove(comp/approved)
    PENDING_HELD --> ACTIVE: T5 approve
    PENDING_HELD --> PENDING_HELD_DENIED: T6 deny
    PENDING_HELD --> WITHDRAWN: T13 withdraw(held)
    PENDING_HELD --> [*]: T9 remove
    PENDING_HELD_DENIED --> PENDING_HELD: T3 re-apply
    PENDING_HELD_DENIED --> WITHDRAWN: T13 withdraw(denied)
    PENDING_HELD_DENIED --> [*]: T8 grace expiry
    PENDING_HOLD_FAILED --> PENDING_HELD: T3m manual-hold
    PENDING_HOLD_FAILED --> PENDING_UNPAID: T6f deny(no hold)
    PENDING_HOLD_FAILED --> WITHDRAWN: T13 withdraw(hold failed)
    PENDING_UNPAID --> ACTIVE: T4 activate(payment)
    PENDING_UNPAID --> PENDING_HELD: T3 apply(−1 ok)
    PENDING_UNPAID --> PENDING_HOLD_FAILED: T3f apply(−1 FAILS)
    PENDING_UNPAID --> WITHDRAWN: T13 withdraw(unpaid)
    PENDING_UNPAID --> [*]: T7 non-payment kick
    WITHDRAWN --> ACTIVE: T15 re-enroll(comp)
    WITHDRAWN --> PENDING_UNPAID: T14 re-enroll(paid)
    [*] --> ACTIVE: T2 enroll(comp)
    [*] --> PENDING_UNPAID: T1 enroll(paid)
    ACTIVE --> [*]
```

## Coverage matrix (state × event → target)

A blank (`—`) cell is a **deliberate** absent edge — a decision to ratify, not an oversight.

| state ╲ event | T1 enroll(paid) | T10 refund restocked | T11 remove(comp/approved) | T12 withdraw | T13 withdraw(denied) | T13 withdraw(held) | T13 withdraw(hold failed) | T13 withdraw(unpaid) | T14 re-enroll(paid) | T15 re-enroll(comp) | T2 enroll(comp) | T3 apply(−1 ok) | T3 re-apply | T3f apply(−1 FAILS) | T3m manual-hold | T4 activate(payment) | T5 approve | T6 deny | T6f deny(no hold) | T7 non-payment kick | T8 grace expiry | T9 remove |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UNENROLLED | PENDING_UNPAID | — | — | — | — | — | — | — | — | — | ACTIVE | — | — | — | — | — | — | — | — | — | — | — |
| PENDING_UNPAID | — | — | — | — | — | — | — | WITHDRAWN | — | — | — | PENDING_HELD | — | PENDING_HOLD_FAILED | — | ACTIVE | — | — | — | UNENROLLED | — | — |
| PENDING_HOLD_FAILED | — | — | — | — | — | — | WITHDRAWN | — | — | — | — | — | — | — | PENDING_HELD | — | — | — | PENDING_UNPAID | — | — | — |
| PENDING_HELD | — | — | — | — | — | WITHDRAWN | — | — | — | — | — | — | — | — | — | — | ACTIVE | PENDING_HELD_DENIED | — | — | — | UNENROLLED |
| PENDING_HELD_DENIED | — | — | — | — | WITHDRAWN | — | — | — | — | — | — | — | PENDING_HELD | — | — | — | — | — | — | — | UNENROLLED | — |
| ACTIVE | — | UNENROLLED | UNENROLLED | WITHDRAWN | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| WITHDRAWN | — | — | — | — | — | — | — | — | PENDING_UNPAID | ACTIVE | — | — | — | — | — | — | — | — | — | — | — | — |

## Reachability

- **Initial:** UNENROLLED
- **Reachable (7):** ACTIVE, PENDING_HELD, PENDING_HELD_DENIED, PENDING_HOLD_FAILED, PENDING_UNPAID, UNENROLLED, WITHDRAWN
- **Terminal (no outbound edge):** (none)
- **Accepting (designated resting states):** ACTIVE
- **Dead-ends (reachable terminal, not accepting):** (none)
- **Unreachable (declared but no legal path from ∅):** (none)
