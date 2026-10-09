/**
 * core.ts flat-merges every classification source into one map keyed by model
 * name, so a model declared by two sources is silently overwritten by the later
 * one — its fields stripped (or exposed) under the wrong tiers. Vendored
 * libraries collide on names (SettingsData, ReceivedOrgEvent, AuditLog, …);
 * each collider must be renamed at port time, and this test catches a miss.
 */
import { CLASSIFICATION_SOURCES } from '../core';

function duplicateKeys(key: 'classifications' | 'relations'): string[] {
    const seenIn = new Map<string, string>();
    const dupes: string[] = [];
    for (const s of CLASSIFICATION_SOURCES) {
        for (const model of Object.keys(s[key])) {
            const first = seenIn.get(model);
            if (first) dupes.push(`${model} (${first}, ${s.source})`);
            else seenIn.set(model, s.source);
        }
    }
    return dupes;
}

describe('classification sources', () => {
    it('declare each model in exactly one source', () => {
        expect(duplicateKeys('classifications')).toEqual([]);
    });

    it('declare each relations entry in exactly one source', () => {
        expect(duplicateKeys('relations')).toEqual([]);
    });

    it('have unique source names', () => {
        const names = CLASSIFICATION_SOURCES.map((s) => s.source);
        expect(new Set(names).size).toBe(names.length);
    });
});
