import { computeDisplayNames } from '@/components/admin/badgeNames';

const run = (names: string[]) => {
    const map = computeDisplayNames(names.map((name, i) => ({ id: i, name })));
    return names.map((_, i) => map.get(i));
};

const runWithNicknames = (people: [name: string, nickname: string | null][]) => {
    const map = computeDisplayNames(people.map(([name, nickname], i) => ({ id: i, name, nickname })));
    return people.map((_, i) => map.get(i));
};

describe('computeDisplayNames', () => {
    it('uses first name only when unique', () => {
        expect(run(['Jane Smith', 'Bob Jones'])).toEqual(['Jane', 'Bob']);
    });

    it('adds last initial when first names collide', () => {
        expect(run(['John Smith', 'John Doe'])).toEqual(['John S.', 'John D.']);
    });

    it('grows the prefix to the minimum needed to disambiguate', () => {
        expect(run(['John Smith', 'John Smythe'])).toEqual(['John Smi.', 'John Smy.']);
    });

    it('falls back to full last name for identical names', () => {
        expect(run(['John Smith', 'John Smith'])).toEqual(['John Smith', 'John Smith']);
    });

    it('shows bare first name for the entry lacking a last name; others disambiguate around it', () => {
        expect(run(['John', 'John Smith'])).toEqual(['John', 'John S.']);
    });

    it('initializes the last name, not the middle name', () => {
        expect(run(['John Frank Doe', 'John Smith'])).toEqual(['John D.', 'John S.']);
    });

    it('initializes the final word of a multi-word last name', () => {
        expect(run(['Maria De La Cruz', 'Maria Diaz'])).toEqual(['Maria C.', 'Maria D.']);
    });

    it('grows the prefix over the last name alone, ignoring the middle name', () => {
        expect(run(['John Frank Doe', 'John Frank Dorsey'])).toEqual(['John Doe', 'John Dor.']);
    });

    it('prints the nickname in place of the first name', () => {
        expect(runWithNicknames([['David Smith', 'Dave'], ['Bob Jones', null]])).toEqual(['Dave', 'Bob']);
    });

    it('disambiguates a nickname against a real first name it collides with', () => {
        expect(runWithNicknames([['David Smith', 'Dave'], ['Dave Sanchez', null]])).toEqual(['Dave Sm.', 'Dave Sa.']);
    });

    it('disambiguates two nicknames against each other', () => {
        expect(runWithNicknames([['David Smith', 'Dave'], ['Davidson Jones', 'Dave']])).toEqual(['Dave S.', 'Dave J.']);
    });

    it('keeps a multi-word nickname whole', () => {
        expect(runWithNicknames([['David Smith', 'Big Dave'], ['Dave Jones', null]])).toEqual(['Big Dave', 'Dave']);
    });

    it('ignores a blank or whitespace-only nickname', () => {
        expect(runWithNicknames([['Jane Smith', '   '], ['Bob Jones', '']])).toEqual(['Jane', 'Bob']);
    });

    it('disambiguates a nickname on the FINAL word of the name, not the middle', () => {
        expect(runWithNicknames([['David Frank Smith', 'Dave'], ['Dave Frank Sanchez', null]])).toEqual(['Dave Sm.', 'Dave Sa.']);
    });

    it('uses the nickname alone when the person has no last name', () => {
        expect(runWithNicknames([['Cher', 'Chezza']])).toEqual(['Chezza']);
    });
});
