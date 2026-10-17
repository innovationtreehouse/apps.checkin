/**
 * Pure renderers that turn a machine's declared `TRANSITIONS` (+ its state
 * metadata) into the machine's review artifacts: a mermaid
 * `stateDiagram`, a coverage matrix, and a reachability report.
 *
 * Dependency-free and deterministic — every list is sorted and every edge
 * deduped, so the same `TRANSITIONS` always render byte-for-byte identically.
 * That determinism is what makes the checked-in artifacts diffable and the drift
 * test (artifactsDrift.test.ts) meaningful: edit a transition without
 * regenerating and the bytes diverge.
 *
 * Never executed against a row — this reads the transition table as data only.
 */
import { reachability, type Transition } from './transitions';

/** Everything the renderers need about one machine. */
export type MachineSpec = {
    /** Slug — also the output filename stem (`<name>.md`). */
    readonly name: string;
    /** Human title for the artifact header. */
    readonly title: string;
    readonly transitions: readonly Transition<string, string, string>[];
    /** Every declared state, in the order rows should appear. */
    readonly allStates: readonly string[];
    /** Entry state(s) for reachability. */
    readonly initials: readonly string[];
    /** Designated legit resting states (a reachable terminal not here = dead-end).
     *  A resting state may still have outbound edges — ARCHIVED rests, unarchive leaves. */
    readonly accepting: readonly string[];
    /** Pseudo-states rendered as mermaid `[*]` (e.g. `∅` / `UNENROLLED`). */
    readonly origins: readonly string[];
};

const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Row list = origins then allStates, deduped, order preserved. */
function rowOrder(spec: MachineSpec): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...spec.origins, ...spec.allStates]) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

function edgeLabel(t: Transition<string, string, string>): string {
    let label = t.event;
    if (t.kind) label += ` · ${t.kind}`;
    if (t.legacy) label += ' · legacy';
    return label;
}

export function renderStateDiagram(spec: MachineSpec): string {
    const origins = new Set(spec.origins);
    const node = (s: string) => (origins.has(s) ? '[*]' : s);

    const edges = uniqSorted(
        spec.transitions.map((t) => `    ${node(t.from)} --> ${node(t.to)}: ${edgeLabel(t)}`),
    );
    // Explicit exit arrows for accepting terminals that aren't already `[*]`.
    const exits = uniqSorted(
        spec.accepting.filter((s) => !origins.has(s)).map((s) => `    ${s} --> [*]`),
    );

    return ['```mermaid', 'stateDiagram-v2', ...edges, ...exits, '```'].join('\n');
}

export function renderCoverageMatrix(spec: MachineSpec): string {
    const rows = rowOrder(spec);
    const events = uniqSorted(spec.transitions.map((t) => t.event));

    // (from, event) → sorted unique targets.
    const cell = new Map<string, Set<string>>();
    for (const t of spec.transitions) {
        const key = `${t.from}\u0000${t.event}`;
        (cell.get(key) ?? cell.set(key, new Set()).get(key)!).add(t.to);
    }
    const at = (from: string, event: string): string => {
        const set = cell.get(`${from}\u0000${event}`);
        return set ? [...set].sort().join(', ') : '—';
    };

    const header = `| state ╲ event | ${events.join(' | ')} |`;
    const sep = `| --- | ${events.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${r} | ${events.map((e) => at(r, e)).join(' | ')} |`);
    return [header, sep, ...body].join('\n');
}

export function renderReachabilityReport(spec: MachineSpec): string {
    const r = reachability(spec.transitions, spec.allStates, spec.initials, spec.accepting);
    const list = (xs: readonly string[]) => (xs.length ? uniqSorted(xs).join(', ') : '(none)');
    return [
        `- **Initial:** ${list(spec.initials)}`,
        `- **Reachable (${new Set(r.reachable).size}):** ${list(r.reachable)}`,
        `- **Terminal (no outbound edge):** ${list(r.terminal)}`,
        `- **Accepting (designated resting states):** ${list(spec.accepting)}`,
        `- **Dead-ends (reachable terminal, not accepting):** ${list(r.deadEnds)}`,
        `- **Unreachable (declared but no legal path from ∅):** ${list(r.unreachable)}`,
    ].join('\n');
}

/** The full checked-in artifact for one machine. Ends with a trailing newline. */
export function renderMachineArtifact(spec: MachineSpec): string {
    return (
        [
            '<!-- GENERATED — do not edit by hand.',
            '     Source: the machine module’s exported TRANSITIONS, via src/lib/lifecycle/machineSpecs.ts.',
            '     Regenerate: npm run generate:lifecycle-artifacts',
            '     Drift-checked by src/lib/lifecycle/__tests__/artifactsDrift.test.ts. -->',
            '',
            `# ${spec.title} — lifecycle artifacts`,
            '',
            'Generated from the machine’s `TRANSITIONS`. Do not hand-edit.',
            '',
            '## State diagram',
            '',
            renderStateDiagram(spec),
            '',
            '## Coverage matrix (state × event → target)',
            '',
            'A blank (`—`) cell is a **deliberate** absent edge — a decision to ratify, not an oversight.',
            '',
            renderCoverageMatrix(spec),
            '',
            '## Reachability',
            '',
            renderReachabilityReport(spec),
        ].join('\n') + '\n'
    );
}
