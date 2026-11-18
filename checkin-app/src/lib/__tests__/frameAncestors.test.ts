import nextConfig from '../../../next.config';

describe('frame-ancestors header', () => {
    it("lets only this origin frame a page, and leaves API responses to their own CSP", async () => {
        const rules = (await nextConfig.headers?.()) ?? [];
        const csp = rules.filter(r => r.headers.some(h => h.key === 'Content-Security-Policy'));
        expect(csp).toEqual([
            { source: '/((?!api/).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }] },
        ]);
        const matches = (path: string) => new RegExp(`^${csp[0].source}$`).test(path);
        expect(matches('/attendance/current')).toBe(true);
        expect(matches('/')).toBe(true);
        expect(matches('/api/scan')).toBe(false);
    });
});
