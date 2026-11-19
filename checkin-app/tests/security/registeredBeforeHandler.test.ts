/**
 * @jest-environment node
 */
/**
 * Each REGISTERED_BEFORE_HANDLER entry is a registered verb whose route file
 * does not serve it through handler() yet. Once the route moves, this fails
 * until the entry is deleted, so the integration sweeps drive it again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getRoute } from '@/security/core';
import '@/security/registry';
import { REGISTERED_BEFORE_HANDLER } from './registeredBeforeHandler';

describe('REGISTERED_BEFORE_HANDLER', () => {
    it('lists only registered verbs whose route file is not yet on handler()', () => {
        for (const endpoint of REGISTERED_BEFORE_HANDLER) {
            expect(getRoute(endpoint)).toBeDefined();
            const [verb, routePath] = endpoint.split(' ');
            const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'app', routePath, 'route.ts'), 'utf8');
            expect(source).toMatch(new RegExp(`export\\s+const\\s+${verb}\\s*=`));
            expect(source).not.toMatch(new RegExp(`export\\s+const\\s+${verb}\\s*=\\s*handler\\s*\\(`));
        }
    });
});
