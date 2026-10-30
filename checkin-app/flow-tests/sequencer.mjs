import testSequencer from "@jest/test-sequencer";

const Sequencer = testSequencer.default ?? testSequencer;
const LAST = "page-smoke.flow.test.ts";

/**
 * Jest's default order, with the page smoke last: it compiles every page and route on the dev
 * server, which slows the first compile of every file after it past their timeouts.
 */
export default class SmokeLastSequencer extends Sequencer {
  async sort(tests) {
    const sorted = await super.sort(tests);
    const isLast = (t) => t.path.endsWith(LAST);
    return [...sorted.filter((t) => !isLast(t)), ...sorted.filter(isLast)];
  }
}
