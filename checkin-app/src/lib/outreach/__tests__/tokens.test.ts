import { findUnknownTokens, substituteTokens } from '@/lib/outreach/tokens';

describe('findUnknownTokens', () => {
    it('accepts every legal token and reports none', () => {
        expect(findUnknownTokens('{{name}} {{deadline}} {{actionWord}} {{actionLink}}')).toEqual([]);
    });

    it('tolerates surrounding whitespace inside the braces', () => {
        expect(findUnknownTokens('{{ name }} {{  deadline  }}')).toEqual([]);
    });

    it('reports an unknown token name', () => {
        expect(findUnknownTokens('Click {{optOutUrl}} now')).toEqual(['optOutUrl']);
    });

    it('dedupes a repeated unknown token', () => {
        expect(findUnknownTokens('{{foo}} and {{foo}} again')).toEqual(['foo']);
    });

    it('reports every distinct unknown token', () => {
        expect(findUnknownTokens('{{foo}} {{bar}} {{name}}').sort()).toEqual(['bar', 'foo']);
    });

    it('is empty for plain text with no tokens', () => {
        expect(findUnknownTokens('Just a plain sentence.')).toEqual([]);
    });
});

describe('substituteTokens', () => {
    const ctx = { name: 'Jordan Rivera', deadline: '2026-08-01', actionWord: 'renew', actionLink: '/membership' };

    it('substitutes every legal token', () => {
        expect(substituteTokens('{{name}}: {{deadline}} / {{actionWord}} / {{actionLink}}', ctx))
            .toBe('Jordan Rivera: 2026-08-01 / renew / /membership');
    });

    it('HTML-escapes {{name}} — an XSS payload renders as text, not markup', () => {
        const evil = { ...ctx, name: '<img src=x onerror=alert(1)>' };
        const out = substituteTokens('Hello {{name}}', evil);
        expect(out).not.toContain('<img');
        expect(out).toBe('Hello &lt;img src=x onerror=alert(1)&gt;');
    });

    it('does not escape deadline/actionWord/actionLink (server-controlled, not user text)', () => {
        const out = substituteTokens('{{actionLink}}', { ...ctx, actionLink: '/membership?a=1&b=2' });
        expect(out).toBe('/membership?a=1&b=2');
    });

    it('leaves an unknown token literally in place (save-time validation is what blocks it)', () => {
        expect(substituteTokens('{{name}} {{bogus}}', ctx)).toBe('Jordan Rivera {{bogus}}');
    });

    it('substitutes repeated occurrences of the same token', () => {
        expect(substituteTokens('{{name}}, again {{name}}!', ctx)).toBe('Jordan Rivera, again Jordan Rivera!');
    });
});
