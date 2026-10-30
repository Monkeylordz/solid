import { describe, expect, it } from "vitest";
import {
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createSignal,
  flush,
  independent,
  type Accessor
} from "../src/index.js";
import { deferred, render, root, settle } from "./independent-helpers.js";

function optimistic(
  store: boolean,
  truth?: Accessor<number>
): [Accessor<number>, (v: number) => void] {
  if (!store) return truth ? createOptimistic(truth) : createOptimistic(0);
  const [state, setState] = truth
    ? createOptimisticStore<{ value: number }>(
        s => {
          s.value = truth();
        },
        { value: 0 }
      )
    : createOptimisticStore({ value: 0 });
  return [
    () => state.value,
    v =>
      setState(s => {
        s.value = v;
      })
  ];
}

describe.each([false, true])("independent optimistic ownership (store=%s)", store => {
  it.each([false, true])("distinct guesses end with their own groups (%s)", async reverse => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, guessA, guessB, values } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const [oa, guessA] = optimistic(store),
        [ob, guessB] = optimistic(store);
      render(createMemo(() => (a() ? ga.promise : 0)));
      render(createMemo(() => (b() ? gb.promise : 0)));
      return { setA, setB, guessA, guessB, values: render(() => [oa(), ob()]) };
    });
    flush();
    independent(() => {
      setA(1);
      guessA(9);
    });
    independent(() => {
      setB(1);
      guessB(8);
    });
    flush();
    expect(values.at(-1)).toEqual([9, 8]);
    (reverse ? gb : ga).resolve(1);
    await settle();
    expect(values.at(-1)).toEqual(reverse ? [9, 0] : [0, 8]);
    (reverse ? ga : gb).resolve(1);
    await settle();
    expect(values.at(-1)).toEqual([0, 0]);
  });

  it.each([false, true])(
    "ordinary and independent guesses retain their parents (%s)",
    async reverse => {
      const ordinaryGate = deferred<number>(),
        separateGate = deferred<number>();
      const { setA, setB, guessA, guessB, a, b } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        const [oa, guessA] = optimistic(store),
          [ob, guessB] = optimistic(store);
        render(createMemo(() => (a() ? ordinaryGate.promise : 0)));
        render(createMemo(() => (b() ? separateGate.promise : 0)));
        return { setA, setB, guessA, guessB, a: render(oa), b: render(ob) };
      });
      flush();
      const separate = () =>
        independent(() => {
          setB(1);
          guessB(8);
        });
      if (reverse) separate();
      setA(1);
      guessA(9);
      if (!reverse) separate();
      flush();
      expect([a, b]).toEqual([
        [0, 9],
        [0, 8]
      ]);
      ordinaryGate.resolve(1);
      await settle();
      expect([a, b]).toEqual([
        [0, 9, 0],
        [0, 8]
      ]);
      separateGate.resolve(1);
      await settle();
      expect([a, b]).toEqual([
        [0, 9, 0],
        [0, 8, 0]
      ]);
    }
  );

  it.each([false, true])("re-guessing the same slot joins both lifetimes (%s)", async reverse => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, setGuess, guesses } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const [guess, setGuess] = optimistic(store);
      render(createMemo(() => (a() ? ga.promise : 0)));
      render(createMemo(() => (b() ? gb.promise : 0)));
      return { setA, setB, setGuess, guesses: render(guess) };
    });
    flush();
    independent(() => {
      setA(1);
      setGuess(9);
    });
    flush();
    independent(() => {
      setB(1);
      setGuess(8);
    });
    flush();
    expect(guesses).toEqual([0, 9, 8]);
    (reverse ? gb : ga).resolve(1);
    await settle();
    expect(guesses).toEqual([0, 9, 8]);
    (reverse ? ga : gb).resolve(1);
    await settle();
    expect(guesses).toEqual([0, 9, 8, 0]);
  });

  it.each([9, 7])(
    "confirmation or correction publishes truth while another group waits (truth=%s)",
    async truth => {
      const ga = deferred<number>(),
        gb = deferred<number>();
      const { setA, setB, setTruth, guessA, guessB, a, b } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0),
          [base, setTruth] = createSignal(0);
        const [oa, guessA] = optimistic(store, base),
          [ob, guessB] = optimistic(store);
        render(createMemo(() => (a() ? ga.promise : 0)));
        render(createMemo(() => (b() ? gb.promise : 0)));
        return { setA, setB, setTruth, guessA, guessB, a: render(oa), b: render(ob) };
      });
      flush();
      independent(() => {
        setA(1);
        setTruth(truth);
        guessA(9);
      });
      independent(() => {
        setB(1);
        guessB(8);
      });
      flush();
      expect([a.at(-1), b.at(-1)]).toEqual([9, 8]);
      ga.resolve(1);
      await settle();
      expect(a).toEqual(truth === 9 ? [0, 9] : [0, 9, 7]);
      expect(b.at(-1)).toBe(8);
      gb.resolve(1);
      await settle();
      expect(b.at(-1)).toBe(0);
      expect(a.at(-1)).toBe(truth);
    }
  );
});
