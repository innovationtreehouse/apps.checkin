import { storedEmail } from '@/lib/prismaEmailNormalize';

describe('storedEmail', () => {
    it.each([
        ['an empty string', ''],
        ['spaces', '   '],
        ['tabs and newlines', '\t\n '],
    ])('stores %s as null', (_label, email) => {
        expect(storedEmail(email)).toBeNull();
    });

    it('trims and lowercases an address', () => {
        expect(storedEmail('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com');
    });
});
