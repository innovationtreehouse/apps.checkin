# Jules Security Sentinel Log

> **Start with [AGENTS.md](../AGENTS.md)** — the shared, canonical orientation
> for all agents in this repo. This file is Jules's running log of security
> learnings, not general instructions; keep it cross-consistent with AGENTS.md.

## 2024-05-24 - [Timing Attack in Webhook Verification]
**Vulnerability:** Found a timing attack vulnerability in `src/app/api/webhooks/shopify/route.ts` where the HMAC signature from Shopify (`headerSignature`) was being compared to the expected signature (`generatedSignature`) using a standard string equality operator (`!==`).
**Learning:** Standard string comparisons fail early as soon as a mismatching character is found. This "fail-fast" behavior leaks timing information to an attacker, theoretically allowing them to guess the correct HMAC character by character and forge a valid Shopify webhook signature to bypass payment verification.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing security-sensitive signatures, hashes, or tokens. Both values must be converted to `Buffer` objects of the exact same length before comparison to ensure constant-time execution regardless of where the mismatch occurs.

## 2024-05-24 - React CSS Injection Vulnerability
**Vulnerability:** Used `dangerouslySetInnerHTML` to inject CSS dynamically in React components (`src/components/ContentWrapper.tsx`).
**Learning:** `dangerouslySetInnerHTML` can open up possibilities for XSS, even if it's currently injecting a static or semi-static string. It bypasses React's built-in escaping mechanisms. The project explicitly avoids using `dangerouslySetInnerHTML` for CSS injection in React components, favoring global CSS rules and class toggling on root elements like `body` (from memory).
**Prevention:** Avoid `dangerouslySetInnerHTML` unless absolutely necessary. Use CSS classes or inline styles with React's `style` prop instead. For global styles, toggle a class on a root element (like `body`) using a `useEffect` hook.

## 2024-05-24 - Dev Auth Exposure in Production
**Vulnerability:** The application was using the feature flag `NEXT_PUBLIC_DEV_AUTH` to enable development-only personas and login mechanisms. If this flag were accidentally set to `true` in a production environment (e.g. through misconfiguration in Vercel), it would expose mock administrative users and allow unauthorized login without a password.
**Learning:** Development feature flags that bypass authentication or authorization are dangerous. They must never be trusted solely by their value in environment variables.
**Prevention:** Always pair development-only feature flags (like `NEXT_PUBLIC_DEV_AUTH`) with a strict environment assertion: `process.env.NODE_ENV !== 'production'`. This provides defense-in-depth, guaranteeing that even if a flag is misconfigured, the potentially dangerous feature cannot be enabled in the production build.

## 2026-05-18 - Sensitive Data Exposure in Email Logs
**Vulnerability:** The application was logging the raw `html` body of emails to the console when `RESEND_API_KEY` was missing in production (e.g., in `src/lib/email.ts`).
**Learning:** Logging entire email bodies can inadvertently expose sensitive information, such as authentication links or personal user details, to server logs where they can be accessed by unauthorized personnel or aggregated inappropriately.
**Prevention:** Avoid logging raw email content in production. Ensure that fallback logging mechanisms only record the full body when `process.env.NODE_ENV === 'development'`. In production, log only metadata like the recipient and subject.

## 2026-06-14 - Dev Auth Exposure via Rules of Hooks Violation
**Vulnerability:** When fixing the dev auth exposure in `DevLoginPicker.tsx`, placing the early environment return (`if (process.env.NODE_ENV === 'production') return null;`) before hook declarations (`useState`, `useEffect`) violated the React Rules of Hooks. While it doesn't crash at runtime since the environment variable is static, it breaks the CI/CD pipeline via `eslint-plugin-react-hooks`.
**Learning:** Security fixes in React components must respect the fundamental Rules of Hooks. Early returns for security/environment checks must be placed after all hook declarations.
**Prevention:** When adding conditional early returns to React components (e.g., environment checks), ensure they are placed after all hook declarations.
## 2026-06-25 - Length Leaks in Secret Verification Check
**Vulnerability:** Found early returns checking buffer lengths (e.g., `providedBuffer.length !== expectedBuffer.length`) on webhook secrets and cron auth tokens before using `crypto.timingSafeEqual`.
**Learning:** Returning early on length mismatch leaks the exact length of the expected secret.
**Prevention:** Hash both the expected and provided secrets to a fixed length (e.g., using SHA-256) before passing them to `crypto.timingSafeEqual` to avoid leaking secret lengths while still safely catching any mismatch.

## 2026-08-22 - ErrorLog Stack Traces Are an Accepted, Gated Diagnostic Surface — Do Not Re-file
**Vulnerability (reported repeatedly):** `logBackendError` (`src/lib/logger.ts`) persists `Error.stack` into the `ErrorLog` table, and the system-status errors panel displays it to administrators.
**Learning:** This is a deliberate, maintainer-reviewed design, not an exposure. `ErrorLog` is wholly `internal` tier, and its only read surface is `GET /api/system-status/errors` — a registered `handler()` route gated sysadmin/board. Those operators are exactly the audience stack traces exist for: the panel is the app's primary diagnostic surface, because production console output lives in CloudWatch, which the operating volunteers do not have day-to-day access to. Stripping `stack` from the row (proposed in multiple prior filings, all closed unmerged) would blank the panel's diagnostic value while removing nothing an attacker can reach — a caller who already holds a sysadmin/board session has far more than directory names.
**Prevention:** Do not re-file "remove stack traces from the database / ErrorLog / admin dashboard". A new finding in this area is warranted only if the exposure actually changes: `stack` becoming readable below the sysadmin/board gate, `ErrorLog` fields re-tiered out of `internal`, or stack contents appearing in any response envelope other than the gated system-status errors route.
