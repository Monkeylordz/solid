/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  Errored,
  Loading,
  Show,
  createMemo,
  createSignal,
  flush,
  independent,
  onCleanup
} from "solid-js";
import { render } from "../src/index.js";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  flush();
});
function mount(app: () => any) {
  const el = document.createElement("div");
  disposers.push(render(app, el));
  flush();
  return el;
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("independent component lifetimes", () => {
  test.each([false, true])(
    "a menu closes while a route retains its old content (%s)",
    async menuFirst => {
      const gate = deferred<number>();
      const [route, setRoute] = createSignal(0),
        [menu, setMenu] = createSignal(true);
      let cleanups = 0;
      const Menu = () => {
        onCleanup(() => {
          cleanups++;
        });
        return <nav>menu</nav>;
      };
      const el = mount(() => {
        const data = createMemo(() => (route() ? gate.promise : 0));
        return (
          <>
            <Show when={menu()}>
              <Menu />
            </Show>
            <Loading fallback={<i>loading</i>}>
              <p>{data()}</p>
            </Loading>
          </>
        );
      });
      const oldPage = el.querySelector("p");
      expect(el.textContent).toBe("menu0");
      if (menuFirst) independent(() => setMenu(false));
      setRoute(1);
      if (!menuFirst) independent(() => setMenu(false));
      await task();
      expect(el.textContent).toBe("0");
      expect(el.querySelector("p")).toBe(oldPage);
      expect(cleanups).toBe(1);
      gate.resolve(1);
      await task();
      expect(el.textContent).toBe("1");
      expect(el.querySelector("nav")).toBeNull();
      expect(cleanups).toBe(1);
    }
  );

  test.each([false, true])(
    "Show removal releases a group's blocker without reviving it (reject=%s)",
    async reject => {
      const gate = deferred<number>(),
        otherGate = deferred<number>();
      const [open, setOpen] = createSignal(true),
        [a, setA] = createSignal(0);
      const [b, setB] = createSignal(0),
        [other, setOther] = createSignal(0);
      let cleanups = 0;
      const Panel = () => {
        onCleanup(() => {
          cleanups++;
        });
        const data = createMemo(() => (a() ? gate.promise : 0));
        return <p>{data()}</p>;
      };
      const el = mount(() => {
        const otherData = createMemo(() => (other() ? otherGate.promise : 0));
        return (
          <>
            <Loading>
              <Show when={open()}>
                <Panel />
              </Show>
            </Loading>
            <b>{b()}</b>
            <Loading>
              <i>{otherData()}</i>
            </Loading>
          </>
        );
      });
      const panel = el.querySelector("p")!;
      independent(() => {
        setA(1);
        setB(1);
      });
      independent(() => setOther(1));
      await task();
      expect(el.textContent).toBe("000");
      independent(() => setOpen(false));
      await task();
      expect(el.textContent).toBe("10");
      expect(el.contains(panel)).toBe(false);
      expect(cleanups).toBe(1);
      reject ? gate.reject(new Error("disposed")) : gate.resolve(1);
      await task();
      expect(el.textContent).toBe("10");
      expect(cleanups).toBe(1);
      otherGate.resolve(2);
      await task();
      expect(el.textContent).toBe("12");
      expect(el.querySelector("p")).toBeNull();
    }
  );

  test("Errored releases a rejected group and recovers while another Loading stays held", async () => {
    const failed = deferred<number>(),
      otherGate = deferred<number>();
    const [a, setA] = createSignal(0),
      [b, setB] = createSignal(0),
      [other, setOther] = createSignal(0);
    let reset!: () => void;
    const el = mount(() => {
      const data = createMemo(() => (a() ? failed.promise : 0));
      const otherData = createMemo(() => (other() ? otherGate.promise : 0));
      return (
        <>
          <Errored
            fallback={(_, retry) => {
              reset = retry;
              return <strong>error</strong>;
            }}
          >
            <Loading fallback={<small>loading</small>}>
              <p>{data()}</p>
            </Loading>
          </Errored>
          <b>{b()}</b>
          <Loading>
            <i>{otherData()}</i>
          </Loading>
        </>
      );
    });
    independent(() => {
      setA(1);
      setB(1);
    });
    independent(() => setOther(1));
    await task();
    expect(el.textContent).toBe("000");
    failed.reject(new Error("failed"));
    await task();
    expect(el.textContent).toBe("error10");
    independent(() => {
      setA(0);
      reset();
    });
    await task();
    expect(el.textContent).toBe("010");
    expect(el.querySelector("strong")).toBeNull();
    otherGate.resolve(2);
    await task();
    expect(el.textContent).toBe("012");
  });

  test("a rearmed Loading fallback releases only its independent group", async () => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const [a, setA] = createSignal(0),
      [b, setB] = createSignal(0);
    const el = mount(() => {
      const av = createMemo(() => (a() ? ga.promise : 0)),
        bv = createMemo(() => (b() ? gb.promise : 0));
      return (
        <>
          <Loading on={a()} fallback={<strong>loading</strong>}>
            <p>{av()}</p>
          </Loading>
          <Loading>
            <i>{bv()}</i>
          </Loading>
        </>
      );
    });
    independent(() => setA(1));
    independent(() => setB(1));
    await task();
    expect(el.textContent).toBe("loading0");
    ga.resolve(1);
    await task();
    expect(el.textContent).toBe("10");
    gb.resolve(2);
    await task();
    expect(el.textContent).toBe("12");
  });
});
