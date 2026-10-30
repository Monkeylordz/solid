/** @vitest-environment jsdom */
import { expect, test } from "vitest";
import fc from "fast-check";
import { createMemo, createRenderEffect, createRoot, createSignal, independent } from "solid-js";
import { runScenario } from "./run.js";
import { describeScenario, scenarioArb, type Scenario } from "./scenario.js";
import { edits } from "./minimize.js";

const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("scenario steps execute independent groups and retain intermediate screens", async () => {
  const sc: Scenario = {
    signals: [0, 0],
    memos: [{ async: true, deps: [{ src: { k: "s", i: 0 }, how: "plain" }], poison: null }],
    tree: {
      t: "group",
      kids: [
        {
          t: "leaf",
          text: [
            { how: "plain", src: { k: "s", i: 0 } },
            { how: "plain", src: { k: "m", i: 0 } }
          ],
          attrs: [],
          grouped: true
        },
        { t: "leaf", text: [{ how: "plain", src: { k: "s", i: 1 } }], attrs: [], grouped: true }
      ]
    },
    steps: [
      { t: "settle", pick: 0 },
      { t: "task" },
      { t: "write", s: 0, v: 1 },
      {
        t: "independent",
        writes: [
          { s: 1, v: 2 },
          { s: 1, v: 3 }
        ]
      },
      { t: "task" }
    ]
  };
  const result = await runScenario(sc);
  expect(result.findings).toEqual([]);
  expect(result.screens.at(-1)).toBe("<span>vs0:0 vm0:1 </span><span>vs1:3 </span>");
  expect(result.final).toBe("<span>vs0:1 vm0:2 </span><span>vs1:3 </span>");
  expect(describeScenario(sc)).toContain("I(s1=2,s1=3)");
  const reductions = edits(sc);
  expect(
    reductions.some(s => s.steps.some(st => st.t === "independent" && st.writes.length === 1))
  ).toBe(true);
  // Signal 1 is referenced only by a group, so dropping it would make a
  // minimized replay invalid even though the tree never reads it.
  const onlyGroupRef: Scenario = {
    signals: [0, 0],
    memos: [],
    tree: { t: "leaf", text: [{ how: "plain", src: { k: "s", i: 0 } }], attrs: [], grouped: true },
    steps: [{ t: "independent", writes: [{ s: 1, v: 1 }] }]
  };
  expect(edits(onlyGroupRef).every(s => s.signals.length === 2)).toBe(true);
});

test("the opt-in scenario cohort generates grouped writes", () => {
  const scenarios = fc.sample(scenarioArb({ independent: true }), { seed: 3289, numRuns: 50 });
  expect(scenarios.some(sc => sc.steps.some(st => st.t === "independent"))).toBe(true);
});

type Operation =
  | { t: "write"; slots: number[]; ordinary: boolean }
  | { t: "settle"; pick: number }
  | { t: "dispose"; slot: number }
  | { t: "empty" };

const operations: fc.Arbitrary<Operation[]> = fc.array(
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant("write" as const),
        slots: fc.array(fc.nat(2), { minLength: 1, maxLength: 4 }),
        ordinary: fc.boolean()
      })
    },
    { weight: 3, arbitrary: fc.record({ t: fc.constant("settle" as const), pick: fc.nat(10) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("dispose" as const), slot: fc.nat(2) }) },
    { weight: 1, arbitrary: fc.constant({ t: "empty" as const }) }
  ),
  { minLength: 1, maxLength: 20 }
);

// This reference model knows only group membership, the latest proposal for
// each slot, and which manual flights settled or lost their final reader.
// It uses no scheduler/transaction internals. Every slot has two signals to
// detect tearing within a write, and scripts overlap slots to merge groups.
test.each([3289, 91501])(
  "group atomicity, isolation and release against a model (seed %s)",
  { timeout: 30_000 },
  async seed => {
    await fc.assert(
      fc.asyncProperty(operations, async script => {
        const committed = [0, 0, 0],
          proposed = [0, 0, 0],
          disabled = [false, false, false];
        const settled = new Set<number>();
        type Group = Set<number>;
        const groups = new Set<Group>(),
          owners: (Group | null)[] = [null, null, null];
        const flights: { slot: number; value: number; resolve(): void }[] = [];
        const snapshots: number[][] = [];
        const results: number[][] = [[], [], []];
        const disposedResults: (number[] | undefined)[] = [];
        let token = 0;
        const { slots, dispose } = createRoot(dispose => {
          const slots = Array.from({ length: 3 }, (_, slot) => {
            const [value, setValue] = createSignal(0),
              [stamp, setStamp] = createSignal(0);
            const disposeBlocker = createRoot(dispose => {
              const data = createMemo(() => {
                const v = value();
                return v === 0
                  ? 0
                  : new Promise<number>(resolve => {
                      flights.push({ slot, value: v, resolve: () => resolve(v) });
                    });
              });
              createRenderEffect(data, v => {
                results[slot].push(v);
              });
              return dispose;
            });
            return { value, stamp, setValue, setStamp, disposeBlocker };
          });
          createRenderEffect(
            () => slots.flatMap(s => [s.value(), s.stamp()]),
            v => {
              snapshots.push(v);
            }
          );
          return { slots, dispose };
        });
        const release = () => {
          const ready: number[][] = [];
          for (const group of groups) {
            if ([...group].some(slot => !disabled[slot] && !settled.has(proposed[slot]))) continue;
            ready.push([...group]);
            for (const slot of group) {
              committed[slot] = proposed[slot];
              owners[slot] = null;
            }
            groups.delete(group);
          }
          return ready;
        };
        const check = async (before: number[], cursor: number, ready: number[][]) => {
          await task();
          const expected = committed.flatMap(v => [v, v]);
          expect(snapshots.at(-1)).toEqual(expected);
          for (const snapshot of snapshots.slice(cursor)) {
            for (let slot = 0; slot < 3; slot++) {
              expect(snapshot[slot * 2]).toBe(snapshot[slot * 2 + 1]);
              if (!ready.some(group => group.includes(slot)))
                expect(snapshot[slot * 2]).toBe(before[slot]);
            }
            // Different ready groups may land in either order; members of one
            // group must all move together, even after transitive overlap.
            for (const group of ready) {
              const oldFrame = group.every(slot => snapshot[slot * 2] === before[slot]);
              const newFrame = group.every(slot => snapshot[slot * 2] === committed[slot]);
              expect(oldFrame || newFrame).toBe(true);
            }
          }
          for (let slot = 0; slot < 3; slot++)
            if (!disabled[slot]) expect(results[slot].at(-1)).toBe(committed[slot]);
            else expect(results[slot]).toEqual(disposedResults[slot]);
        };
        try {
          await task();
          expect(snapshots).toEqual([[0, 0, 0, 0, 0, 0]]);
          for (const operation of script) {
            const before = [...committed],
              cursor = snapshots.length;
            if (operation.t === "write") {
              const group: Group = new Set();
              groups.add(group);
              const writes = operation.slots.map(slot => ({ slot, value: ++token }));
              for (const { slot, value } of writes) {
                const previous = owners[slot];
                if (previous && previous !== group) {
                  for (const member of previous) {
                    group.add(member);
                    owners[member] = group;
                  }
                  groups.delete(previous);
                }
                group.add(slot);
                owners[slot] = group;
                proposed[slot] = value;
              }
              const write = () => {
                for (const { slot, value } of writes) {
                  slots[slot].setValue(value);
                  slots[slot].setStamp(value);
                }
              };
              operation.ordinary ? write() : independent(write);
            } else if (operation.t === "settle" && flights.length) {
              const [flight] = flights.splice(operation.pick % flights.length, 1);
              settled.add(flight.value);
              flight.resolve();
            } else if (operation.t === "dispose") {
              disposedResults[operation.slot] ??= [...results[operation.slot]];
              disabled[operation.slot] = true;
              slots[operation.slot].disposeBlocker();
            } else if (operation.t === "empty") independent(() => {});
            await check(before, cursor, release());
          }
          // Settle stale flights too: they must never resurrect old proposals.
          const before = [...committed],
            cursor = snapshots.length;
          for (const flight of flights.splice(0)) {
            settled.add(flight.value);
            flight.resolve();
          }
          await check(before, cursor, release());
          expect(groups.size).toBe(0);
        } finally {
          dispose();
          for (const flight of flights.splice(0)) flight.resolve();
          await task();
        }
      }),
      { seed, numRuns: 50 }
    );
  }
);
