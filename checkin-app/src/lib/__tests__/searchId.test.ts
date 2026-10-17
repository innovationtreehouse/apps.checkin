import { householdQueryMatcher, personQueryMatcher, searchId } from '@/lib/searchId';

describe('searchId', () => {
    it('reads a bare number as an id', () => {
        expect(searchId('42')).toBe(42);
        expect(searchId('  42  ')).toBe(42);
    });

    it('is null for anything that is not all digits', () => {
        expect(searchId('ali')).toBeNull();
        expect(searchId('42a')).toBeNull();
        expect(searchId('4 2')).toBeNull();
        expect(searchId('-1')).toBeNull();
        expect(searchId('4.2')).toBeNull();
        expect(searchId('')).toBeNull();
    });

    it('is null past the int4 ceiling, which no id reaches', () => {
        expect(searchId('2147483647')).toBe(2147483647);
        expect(searchId('2147483648')).toBeNull();
        expect(searchId('99999999999999999999')).toBeNull();
    });
});

describe('personQueryMatcher', () => {
    const person = { id: 42, name: 'Ali Ada', email: 'ali@example.com' };

    it('matches on name or email, case-insensitively', () => {
        expect(personQueryMatcher('ali')(person)).toBe(true);
        expect(personQueryMatcher('ADA')(person)).toBe(true);
        expect(personQueryMatcher('EXAMPLE.com')(person)).toBe(true);
        expect(personQueryMatcher('bob')(person)).toBe(false);
    });

    it('matches the id exactly, not as a substring', () => {
        expect(personQueryMatcher('42')(person)).toBe(true);
        expect(personQueryMatcher(' 42 ')(person)).toBe(true);
        expect(personQueryMatcher('4')(person)).toBe(false);
    });

    it('matches everything on an empty query', () => {
        expect(personQueryMatcher('')(person)).toBe(true);
        expect(personQueryMatcher('   ')(person)).toBe(true);
    });

    it('does not match on a field the caller did not supply', () => {
        expect(personQueryMatcher('example.com')({ id: 42, name: 'Ali Ada' })).toBe(false);
    });

    it('parses the query once, not once per row', () => {
        const matches = personQueryMatcher('42');
        expect([{ id: 41 }, { id: 42 }, { id: 43 }].filter(matches)).toEqual([{ id: 42 }]);
    });
});

describe('householdQueryMatcher', () => {
    const household = { id: 7, name: 'Ada Household' };

    it('matches on name or the household\'s own id', () => {
        expect(householdQueryMatcher('ada')(household)).toBe(true);
        expect(householdQueryMatcher('7')(household)).toBe(true);
        expect(householdQueryMatcher('77')(household)).toBe(false);
        expect(householdQueryMatcher('bell')(household)).toBe(false);
    });

    it('matches an unnamed household on the label the caller passes in', () => {
        expect(householdQueryMatcher('household #7')({ id: 7, name: 'Household #7' })).toBe(true);
        expect(householdQueryMatcher('ada')({ id: 7, name: null })).toBe(false);
    });

    it('matches everything on an empty query', () => {
        expect(householdQueryMatcher('')(household)).toBe(true);
    });
});
