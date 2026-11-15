import { outreachCtx, OUTREACH_KEY } from '@/lib/outreach/render';
import { REGISTRY } from '@/lib/email-templates/registry';
import { renderTemplate } from '@/lib/email-templates/tokens';

describe('outreachCtx', () => {
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

    it('fills {{deadline}} as YYYY-MM-DD from the resolved boundary and links /membership', () => {
        expect(outreachCtx('Jordan', boundary)).toEqual({
            name: 'Jordan',
            deadline: '2026-08-01',
            actionLink: 'http://localhost:4000/membership',
        });
    });

    it.each(['opening', 'reminder'] as const)('the %s default renders the name escaped and the link as an anchor', (emailType) => {
        const spec = REGISTRY[OUTREACH_KEY[emailType]];
        const { subject, html } = renderTemplate(spec.defaultSubject, spec.defaultBody, outreachCtx('<script>x</script>', boundary), spec.allowedTokens);
        expect(subject).not.toContain('{{');
        expect(html).toContain('Hi &lt;script&gt;x&lt;/script&gt;,');
        expect(html).toContain('2026-08-01');
        expect(html).toContain('<a href="http://localhost:4000/membership">http://localhost:4000/membership</a>');
    });
});
