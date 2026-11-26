<!-- GENERATED — do not edit by hand.
     Source: the machine module’s exported TRANSITIONS, via src/lib/lifecycle/machineSpecs.ts.
     Regenerate: npm run generate:lifecycle-artifacts
     Drift-checked by src/lib/lifecycle/__tests__/artifactsDrift.test.ts. -->

# OrgMembershipProcess — lifecycle artifacts

Generated from the machine’s `TRANSITIONS`. Do not hand-edit.

## State diagram

```mermaid
stateDiagram-v2
    ARCHIVED --> BLOCKED: unarchiveApplication · legacy
    ARCHIVED --> INTAKE: unarchiveApplication
    ARCHIVED --> PENDING_BG_CLEARANCE: unarchiveApplication · legacy
    ARCHIVED --> PENDING_BG_REVIEW: unarchiveApplication
    ARCHIVED --> PENDING_EXTERNAL_ACTION: unarchiveApplication
    ARCHIVED --> PENDING_PAYMENT: unarchiveApplication
    ARCHIVED --> PENDING_RENEWAL: unarchiveApplication
    BLOCKED --> ARCHIVED: closeHouseholdApplications
    BLOCKED --> ARCHIVED: recordRefund
    BLOCKED --> INTAKE: settleHouseholdBg
    BLOCKED --> PENDING_BG_CLEARANCE: boardResetReview · legacy
    BLOCKED --> PENDING_BG_CLEARANCE: settleHouseholdBg
    BLOCKED --> PENDING_BG_REVIEW: attest change to APPROVE · PERSON_BG
    BLOCKED --> PENDING_BG_REVIEW: boardResetReview · PERSON_BG
    BLOCKED --> PENDING_BG_REVIEW: settleHouseholdBg
    BLOCKED --> PENDING_EXTERNAL_ACTION: boardResetReview · legacy
    BLOCKED --> PENDING_EXTERNAL_ACTION: settleHouseholdBg
    BLOCKED --> PENDING_PAYMENT: boardResetReview · legacy
    BLOCKED --> PENDING_PAYMENT: settleHouseholdBg
    BLOCKED --> PENDING_RENEWAL: settleHouseholdBg
    INTAKE --> ARCHIVED: archiveApplication
    INTAKE --> ARCHIVED: closeHouseholdApplications
    INTAKE --> ARCHIVED: recordRefund
    INTAKE --> BLOCKED: settleHouseholdBg
    INTAKE --> PENDING_EXTERNAL_ACTION: submitIntake · INITIAL
    PENDING_BG_CLEARANCE --> ACTIVE: settleHouseholdBg
    PENDING_BG_CLEARANCE --> ARCHIVED: closeHouseholdApplications
    PENDING_BG_CLEARANCE --> ARCHIVED: recordRefund
    PENDING_BG_CLEARANCE --> BLOCKED: settleHouseholdBg
    PENDING_BG_CLEARANCE --> PENDING_EXTERNAL_ACTION: settleHouseholdBg
    PENDING_BG_CLEARANCE --> PENDING_PAYMENT: recordRefund
    PENDING_BG_REVIEW --> ACTIVE: clearBackgroundCheck · PERSON_BG
    PENDING_BG_REVIEW --> ACTIVE: settleHouseholdBg · legacy
    PENDING_BG_REVIEW --> ARCHIVED: archiveApplication
    PENDING_BG_REVIEW --> ARCHIVED: attest names a person with an empty review · PERSON_BG
    PENDING_BG_REVIEW --> ARCHIVED: closeHouseholdApplications
    PENDING_BG_REVIEW --> ARCHIVED: dismissCheckStarted · PERSON_BG
    PENDING_BG_REVIEW --> ARCHIVED: recordRefund
    PENDING_BG_REVIEW --> ARCHIVED: settleHouseholdBg closes an unneeded unnamed review · PERSON_BG
    PENDING_BG_REVIEW --> BLOCKED: attest REJECT · PERSON_BG
    PENDING_BG_REVIEW --> BLOCKED: settleHouseholdBg
    PENDING_BG_REVIEW --> PENDING_BG_CLEARANCE: settleHouseholdBg · legacy
    PENDING_BG_REVIEW --> PENDING_EXTERNAL_ACTION: settleHouseholdBg · legacy
    PENDING_BG_REVIEW --> PENDING_PAYMENT: settleHouseholdBg · legacy
    PENDING_EXTERNAL_ACTION --> ACTIVE: markContractSigned · KEY_VOLUNTEER_AGREEMENT
    PENDING_EXTERNAL_ACTION --> ACTIVE: markContractSigned · PERSON_AGREEMENT
    PENDING_EXTERNAL_ACTION --> ARCHIVED: archiveApplication
    PENDING_EXTERNAL_ACTION --> ARCHIVED: closeHouseholdApplications
    PENDING_EXTERNAL_ACTION --> ARCHIVED: closePersonAgreementOnLead · PERSON_AGREEMENT
    PENDING_EXTERNAL_ACTION --> ARCHIVED: recordRefund
    PENDING_EXTERNAL_ACTION --> BLOCKED: settleHouseholdBg
    PENDING_EXTERNAL_ACTION --> PENDING_BG_CLEARANCE: advanceExternalIfComplete
    PENDING_EXTERNAL_ACTION --> PENDING_PAYMENT: advanceExternalIfComplete
    PENDING_PAYMENT --> ACTIVE: activate
    PENDING_PAYMENT --> ACTIVE: grantMembership
    PENDING_PAYMENT --> ARCHIVED: archiveApplication
    PENDING_PAYMENT --> ARCHIVED: closeHouseholdApplications
    PENDING_PAYMENT --> ARCHIVED: recordRefund
    PENDING_PAYMENT --> BLOCKED: settleHouseholdBg
    PENDING_PAYMENT --> PENDING_BG_CLEARANCE: activate
    PENDING_PAYMENT --> PENDING_EXTERNAL_ACTION: activate
    PENDING_RENEWAL --> ARCHIVED: archiveApplication
    PENDING_RENEWAL --> ARCHIVED: closeHouseholdApplications
    PENDING_RENEWAL --> ARCHIVED: recordRefund
    PENDING_RENEWAL --> BLOCKED: settleHouseholdBg
    PENDING_RENEWAL --> PENDING_EXTERNAL_ACTION: beginRenewal · RENEWAL
    RENEWAL_PENDING_BG --> ARCHIVED: archiveApplication · legacy
    RENEWAL_PENDING_BG --> ARCHIVED: closeHouseholdApplications · legacy
    RENEWAL_PENDING_BG --> ARCHIVED: recordRefund · legacy
    [*] --> INTAKE: startIntake · INITIAL
    [*] --> PENDING_BG_REVIEW: legacy household flag (no subject) · PERSON_BG · legacy
    [*] --> PENDING_BG_REVIEW: markCheckStarted · PERSON_BG
    [*] --> PENDING_BG_REVIEW: personBgTriggers · PERSON_BG
    [*] --> PENDING_EXTERNAL_ACTION: openKvaIfNeeded · KEY_VOLUNTEER_AGREEMENT
    [*] --> PENDING_EXTERNAL_ACTION: personAgreementTriggers · PERSON_AGREEMENT
    [*] --> PENDING_RENEWAL: createRenewalProcess · RENEWAL
    ACTIVE --> [*]
    ARCHIVED --> [*]
```

## Coverage matrix (state × event → target)

A blank (`—`) cell is a **deliberate** absent edge — a decision to ratify, not an oversight.

| state ╲ event | activate | advanceExternalIfComplete | archiveApplication | attest REJECT | attest change to APPROVE | attest names a person with an empty review | beginRenewal | boardResetReview | clearBackgroundCheck | closeHouseholdApplications | closePersonAgreementOnLead | createRenewalProcess | dismissCheckStarted | grantMembership | legacy household flag (no subject) | markCheckStarted | markContractSigned | openKvaIfNeeded | personAgreementTriggers | personBgTriggers | recordRefund | settleHouseholdBg | settleHouseholdBg closes an unneeded unnamed review | startIntake | submitIntake | unarchiveApplication |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ∅ | — | — | — | — | — | — | — | — | — | — | — | PENDING_RENEWAL | — | — | PENDING_BG_REVIEW | PENDING_BG_REVIEW | — | PENDING_EXTERNAL_ACTION | PENDING_EXTERNAL_ACTION | PENDING_BG_REVIEW | — | — | — | INTAKE | — | — |
| INTAKE | — | — | ARCHIVED | — | — | — | — | — | — | ARCHIVED | — | — | — | — | — | — | — | — | — | — | ARCHIVED | BLOCKED | — | — | PENDING_EXTERNAL_ACTION | — |
| PENDING_EXTERNAL_ACTION | — | PENDING_BG_CLEARANCE, PENDING_PAYMENT | ARCHIVED | — | — | — | — | — | — | ARCHIVED | ARCHIVED | — | — | — | — | — | ACTIVE | — | — | — | ARCHIVED | BLOCKED | — | — | — | — |
| PENDING_BG_REVIEW | — | — | ARCHIVED | BLOCKED | — | ARCHIVED | — | — | ACTIVE | ARCHIVED | — | — | ARCHIVED | — | — | — | — | — | — | — | ARCHIVED | ACTIVE, BLOCKED, PENDING_BG_CLEARANCE, PENDING_EXTERNAL_ACTION, PENDING_PAYMENT | ARCHIVED | — | — | — |
| PENDING_PAYMENT | ACTIVE, PENDING_BG_CLEARANCE, PENDING_EXTERNAL_ACTION | — | ARCHIVED | — | — | — | — | — | — | ARCHIVED | — | — | — | ACTIVE | — | — | — | — | — | — | ARCHIVED | BLOCKED | — | — | — | — |
| PENDING_BG_CLEARANCE | — | — | — | — | — | — | — | — | — | ARCHIVED | — | — | — | — | — | — | — | — | — | — | ARCHIVED, PENDING_PAYMENT | ACTIVE, BLOCKED, PENDING_EXTERNAL_ACTION | — | — | — | — |
| ACTIVE | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| BLOCKED | — | — | — | — | PENDING_BG_REVIEW | — | — | PENDING_BG_CLEARANCE, PENDING_BG_REVIEW, PENDING_EXTERNAL_ACTION, PENDING_PAYMENT | — | ARCHIVED | — | — | — | — | — | — | — | — | — | — | ARCHIVED | INTAKE, PENDING_BG_CLEARANCE, PENDING_BG_REVIEW, PENDING_EXTERNAL_ACTION, PENDING_PAYMENT, PENDING_RENEWAL | — | — | — | — |
| PENDING_RENEWAL | — | — | ARCHIVED | — | — | — | PENDING_EXTERNAL_ACTION | — | — | ARCHIVED | — | — | — | — | — | — | — | — | — | — | ARCHIVED | BLOCKED | — | — | — | — |
| RENEWAL_PENDING_BG | — | — | ARCHIVED | — | — | — | — | — | — | ARCHIVED | — | — | — | — | — | — | — | — | — | — | ARCHIVED | — | — | — | — | — |
| ARCHIVED | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | BLOCKED, INTAKE, PENDING_BG_CLEARANCE, PENDING_BG_REVIEW, PENDING_EXTERNAL_ACTION, PENDING_PAYMENT, PENDING_RENEWAL |

## Reachability

- **Initial:** INTAKE, PENDING_BG_REVIEW, PENDING_RENEWAL
- **Reachable (9):** ACTIVE, ARCHIVED, BLOCKED, INTAKE, PENDING_BG_CLEARANCE, PENDING_BG_REVIEW, PENDING_EXTERNAL_ACTION, PENDING_PAYMENT, PENDING_RENEWAL
- **Terminal (no outbound edge):** ACTIVE
- **Accepting (designated resting states):** ACTIVE, ARCHIVED
- **Dead-ends (reachable terminal, not accepting):** (none)
- **Unreachable (declared but no legal path from ∅):** RENEWAL_PENDING_BG
