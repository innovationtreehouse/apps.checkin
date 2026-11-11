// Manual Jest mock for @/lib/email (sibling of __mocks__/auth-options.ts). Records every send
// in-memory and reports success, so same-process unit tests can assert "an email with link X was
// sent to Y" without a real key or DB. For cross-process integration tests (where the app runs in
// a separate process) query the DevSentEmail table / GET /dev/sent-mail instead. See EMAIL_DEV_MOCK.md §7.
//
// Usage:
//   jest.mock('@/lib/email');
//   import { sendEmail, __getSentEmails, __clearSentEmails } from '@/lib/email';
//   afterEach(() => __clearSentEmails());
//   expect(__getSentEmails()).toContainEqual(
//       expect.objectContaining({ to: 'x@y', html: expect.stringContaining('/membership-ops/review') }),
//   );

export interface RecordedEmail {
    to: string;
    subject: string;
    html: string;
}

const sent: RecordedEmail[] = [];

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    sent.push({ to, subject, html });
    return true;
}

export function __getSentEmails(): RecordedEmail[] {
    return [...sent];
}

export function __clearSentEmails(): void {
    sent.length = 0;
}

// emailRecipients.ts's fanOutEmails routes through runPaced — a synchronous
// passthrough here keeps this mock timer-free, matching every other runPaced mock
// in the suite (notifications.test.ts, the announce integration tests).
export async function runPaced<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(tasks.map((t) => t()));
}
