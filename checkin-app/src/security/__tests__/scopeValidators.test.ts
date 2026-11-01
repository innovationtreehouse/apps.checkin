/**
 * Arms the security scope validators (scopes.ts §7.6). They are pure config
 * checks with no runtime caller — this test is what makes them enforce anything.
 * See docs/security/auth-consistency-analysis.md §9 Step 3.
 *
 * Both assertions must stay `toEqual([])`. If one goes red, DO NOT pin it to the
 * current error list — a red test naming a real gap is the point of the gate.
 */
import { validateBindings, validateRouteGrants } from '../scopes';
import { SCOPE_BINDINGS, OPT_OUT_PENDING_ROUTE } from '../scopeBindings';
import { classifications, allRoutes } from '../core';

describe('security scope validators (assert green)', () => {
    it('validateBindings: bindings field-exist + every sensitive model covered', () => {
        expect(
            validateBindings(SCOPE_BINDINGS, classifications, OPT_OUT_PENDING_ROUTE),
        ).toEqual([]);
    });

    it('validateRouteGrants: every row-scoped grant is resolvable on a returned model', () => {
        const specs = [...allRoutes()].map(([, spec]) => spec);
        expect(validateRouteGrants(specs, SCOPE_BINDINGS)).toEqual([]);
    });
});
