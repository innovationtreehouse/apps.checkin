import { renderOutreachEmail } from '@/lib/outreach/render';

describe('renderOutreachEmail', () => {
    const prevSecret = process.env.NEXTAUTH_SECRET;
    const prevUrl = process.env.NEXTAUTH_URL;
    const boundary = new Date(Date.UTC(2026, 7, 1)); // Aug 1 2026

    beforeAll(() => {
        process.env.NEXTAUTH_SECRET = 'unit-test-nextauth-secret';
        process.env.NEXTAUTH_URL = 'http://localhost:4000';
    });
    afterAll(() => {
        if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = prevSecret;
        if (prevUrl === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = prevUrl;
    });

    it('renders {{deadline}} as YYYY-MM-DD from the resolved boundary', () => {
        const { subject } = renderOutreachEmail('Renew by {{deadline}}', 'body', { name: 'A', boundary });
        expect(subject).toBe('Renew by 2026-08-01');
    });

    it('escapes {{name}} — an XSS payload in the name renders as text', () => {
        const { html } = renderOutreachEmail('s', 'Hello {{name}}', { name: '<script>alert(1)</script>', boundary });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('actionWord is always "renew"', () => {
        expect(renderOutreachEmail('{{actionWord}}', 'b', { name: 'A', boundary }).subject).toBe('renew');
    });

    it('actionLink is /membership and nothing is appended after the body', () => {
        const { html } = renderOutreachEmail('s', '{{actionLink}}', { name: 'A', boundary });
        expect(html).toBe('http://localhost:4000/membership');
    });
});
