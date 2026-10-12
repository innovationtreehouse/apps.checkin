/**
 * @jest-environment node
 *
 * deploy/prod-initdb/10-library-dbs.sh reads libraries.json with a line-based
 * sed, not a JSON parser. Pin the file to the shape that sed understands.
 */
import * as fs from 'fs';
import * as path from 'path';

const raw = fs.readFileSync(path.join(__dirname, '..', 'libraries.json'), 'utf8');
const libraries: { name: string; package: string; routePrefixes: string[] }[] = JSON.parse(raw);

describe('libraries.json', () => {
    it('lists one entry per line', () => {
        const entryLines = raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line !== '' && line !== '[' && line !== ']');
        expect(entryLines.map(line => JSON.parse(line.replace(/,$/, '')))).toEqual(libraries);
    });

    it('yields the same names to the initdb sed as to JSON.parse', () => {
        const sedNames = raw
            .split('\n')
            .map(line => line.match(/.*"name": *"([^"]*)".*/)?.[1])
            .filter((name): name is string => name !== undefined);
        expect(sedNames).toEqual(libraries.map(l => l.name));
    });

    it('gives every entry a package and at least one route prefix', () => {
        for (const l of libraries) {
            expect(l.package).toMatch(/^@/);
            expect(l.routePrefixes.length).toBeGreaterThan(0);
            for (const p of l.routePrefixes) expect(p).toMatch(/^\/api\/.+\/$/);
        }
    });
});
