import {
  CONFIG_CHILDREN_FORBIDDEN,
  CONFIG_HELD,
  CONFIG_INPUTS_PUBLISHED,
  CONFIG_OVERRIDE,
  CONFIG_VERDICT,
  EFFECT_RENDER,
  NewSet,
  NOT_PENDING,
  REACTIVE_JOINED,
  STATUS_PENDING,
  STATUS_UNINITIALIZED
} from "./core/constants.js";
import { bornInto, unflushedStaged, unflushedValue } from "./core/core.js";
import {
  flushTransaction,
  blocked,
  globalQueue,
  installIndependentHooks,
  laneStageHook,
  liveTx,
  merge,
  newTransaction,
  parkNode,
  passLane,
  resolveTx,
  schedule,
  setFlushTransaction,
  staleReader,
  storeParkHook,
  txOf,
  type IndependentHooks,
  type QueueCallback,
  type Transaction
} from "./core/scheduler.js";
import type { Computed, Signal } from "./core/types.js";

// null is the ordinary batch; false is a render pass dirtied by several
// groups. Proposal ownership is separate from CONFIG_HELD: a group need
// not suspend, and identifying it must not change read visibility.
type Seat = Transaction | null | false;
let current: Seat = null;
let observer: Computed<any> | null = null;
let ambient: Transaction | null = null;
// The optional wrapper re-enters the original core function once. Consume
// this bypass at entry so nested pulls still establish their own context.
let bypass = false;
// A constructor binding avoids repeated retained PURE annotations. Only
// guess ownership can disappear while the grouping engine itself is kept.
const Ownership = WeakMap;
const proposals = new Ownership<Signal<any>, Transaction | null>();
const causes = new Ownership<Computed<any>, Seat>();
let guesses = /*@__PURE__*/ new Ownership<Signal<any>, Transaction | null>();
let trims = new Ownership<Computed<any>, Seat>();
const replays = new Ownership<Computed<any>, Transaction[]>();
const independentGroups = new NewSet<Transaction>();

function transaction(seat: Seat | undefined): Transaction | null {
  const t = seat === null ? ambient : seat || null;
  return t && liveTx(t);
}
function same(a: Seat, b: Seat): boolean {
  return a === b || (a !== false && b !== false && transaction(a) === transaction(b));
}
function ensure(seat: Transaction | null): Transaction {
  return transaction(seat) || (ambient = newTransaction(false));
}
function join(a: Transaction | null, b: Transaction | null): void {
  const x = transaction(a),
    y = transaction(b);
  if (x && y) merge(x, y);
  if (a === null || b === null) ambient = x || y;
  setFlushTransaction(transaction(current));
}
function enter(seat: Seat): Seat {
  const previous = current;
  if (current === null) ambient = flushTransaction;
  current = seat && transaction(seat);
  setFlushTransaction(transaction(seat));
  return previous;
}
function exit(previous: Seat): void {
  current = previous && transaction(previous);
  setFlushTransaction(transaction(current));
}
function run<T>(seat: Seat, fn: () => T, nextObserver = observer): T {
  const previous = enter(seat),
    previousObserver = observer;
  observer = nextObserver;
  try {
    bypass = true;
    return fn();
  } finally {
    bypass = false;
    observer = previousObserver;
    exit(previous);
  }
}
function includes(groups: Iterable<Transaction>, t: Transaction): boolean {
  t = resolveTx(t);
  for (const group of groups) if (resolveTx(group) === t) return true;
  return false;
}
const hooks: IndependentHooks = {
  _active: false,
  _compute(node, create, fn) {
    if (bypass) {
      bypass = false;
      return false;
    }
    const seat = create ? current : (causes.get(node) ?? null);
    causes.delete(node);
    replays.delete(node);
    if (!hooks._active) return false;
    run(seat, () => fn(node, create), node);
    return true;
  },
  _wrap() {
    if (!bypass) return hooks._active;
    bypass = false;
    return false;
  },
  _run(node, fn) {
    // Called only after _wrap has checked activation and consumed the bypass.
    const t =
      (node as Transaction)._nodes !== undefined
        ? resolveTx(node as Transaction)
        : (node as Signal<any>)._config & CONFIG_HELD
          ? txOf(node as Signal<any>)
          : transaction(proposals.get(node as Signal<any>) ?? null);
    return run(t && includes(independentGroups, t) ? t : null, fn);
  },
  _joined(t) {
    if (!hooks._active) return;
    current = current && transaction(current);
    if (current === null) ambient = t;
    else if (current !== false) {
      independentGroups.add(t);
      current = t;
    }
  },
  _write(node, changed) {
    if (!changed && node._pendingValue === NOT_PENDING) return;
    current = current && transaction(current);
    if (current === false || passLane !== null || node._config & CONFIG_OVERRIDE) return;
    const previous = proposals.get(node);
    if (hooks._active && previous !== undefined && (node as any)._type !== EFFECT_RENDER)
      join(previous, current);
    proposals.set(node, current);
  },
  _cause(node, sub) {
    if (passLane !== null || current === false) return;
    const proposal = proposals.get(node);
    const seat = proposal === undefined ? current : proposal;
    if (!hooks._active) {
      causes.set(sub, null);
      return;
    }
    const previous = causes.get(sub);
    if (previous !== undefined) {
      if (previous === false || same(previous, seat)) return;
      if ((sub as any)._type === EFFECT_RENDER) {
        causes.set(sub, false);
        return;
      }
      join(previous, seat);
    }
    causes.set(sub, seat);
  },
  _read(reader, node) {
    const seat = proposals.get(node);
    if (
      seat === undefined ||
      !hooks._active ||
      reader._config & (CONFIG_CHILDREN_FORBIDDEN | CONFIG_VERDICT) ||
      passLane !== null ||
      node._config & CONFIG_OVERRIDE ||
      (!globalQueue._running && unflushedStaged && unflushedValue(node) !== NOT_PENDING)
    )
      return false;
    if ((reader as any)._type === EFFECT_RENDER) {
      const t = transaction(seat);
      if (
        !same(current, seat) &&
        !((node as Computed<any>)._statusFlags & STATUS_UNINITIALIZED) &&
        !(node._config & CONFIG_INPUTS_PUBLISHED) &&
        !(t && bornInto(reader, t))
      ) {
        staleReader(reader, ensure(seat));
        return true;
      }
      return false;
    }
    if (
      !(node._config & CONFIG_HELD) &&
      current !== false &&
      (node._pendingValue !== NOT_PENDING || (node as Computed<any>)._statusFlags & STATUS_PENDING)
    ) {
      join(current, seat);
      if (transaction(current)) reader._flags |= REACTIVE_JOINED;
    }
    return false;
  },
  _enqueue(type: number, fn: QueueCallback) {
    if (!hooks._active) return false;
    current = current && transaction(current);
    // A shared pass reads the committed world. A ready group's landing
    // requeues it before its callback can show an obsolete combination.
    if (current === false) return observer !== null && replays.has(observer);
    if (current === null) return false;
    resolveTx(current)._queues[type - 1].push(fn);
    return true;
  },
  _park(nodes) {
    if (!hooks._active) return;
    let count = 0;
    for (const node of nodes) {
      const t = transaction(proposals.get(node));
      if (t && t !== transaction(null)) {
        // Parking changes this node and its frame, not group membership:
        // no intermediate map or per-group staging arrays are needed.
        parkNode(node, t);
        if (node._config & CONFIG_HELD) proposals.set(node, txOf(node));
        else if (node._pendingValue === NOT_PENDING) proposals.delete(node);
      } else nodes[count++] = node;
    }
    nodes.length = count;
    // Freeze the ordinary batch's identity before the next batch starts.
    const t = transaction(null);
    if (t) for (const node of nodes) if (proposals.get(node) !== undefined) proposals.set(node, t);
    setFlushTransaction(t);
  },
  _seam() {
    if (!hooks._active) return;
    for (const t of independentGroups) if (!liveTx(t)) independentGroups.delete(t);
    hooks._active = independentGroups.size !== 0;
    ambient = null;
    trims = new Ownership();
    setFlushTransaction((current && liveTx(current)) || null);
  },
  _commit(node) {
    proposals.delete(node);
  },
  _guess(node) {
    // Without optimistic primitives, the consumer can drop guess ownership.
    if (!laneStageHook || current === false) return;
    const previous = guesses.get(node);
    if (hooks._active && previous !== undefined) join(previous, current);
    guesses.set(node, current);
  },
  _guessParent(node) {
    if (!laneStageHook) return;
    if (node === undefined) {
      guesses = new Ownership();
      return;
    }
    const seat = guesses.get(node);
    return hooks._active && seat !== undefined ? transaction(seat) : undefined;
  },
  _stale(reader, t) {
    if (!hooks._active) return false;
    let groups = replays.get(reader);
    if (!groups) replays.set(reader, (groups = []));
    if (includes(groups, t)) return false;
    groups.push(t);
    return true;
  },
  _replay(reader, t) {
    const groups = replays.get(reader);
    return !!groups && (!t || includes(groups, t));
  },
  _trim(node, record) {
    if (record) {
      if (hooks._active) trims.set(node, current);
      return false;
    }
    const t = transaction(trims.get(node));
    return t !== null && blocked(t);
  },
  _zombies(nodes, ready) {
    if (!hooks._active) return;
    let count = 0;
    for (const node of nodes) {
      const t = transaction(causes.get(node) ?? null);
      if (t !== null && blocked(t)) continue;
      if (ready) {
        if (!(node._config & CONFIG_VERDICT)) ready.push(node);
      } else nodes[count++] = node;
    }
    if (!ready) nodes.length = count;
  }
};
installIndependentHooks(hooks);

/**
 * Execute `fn` synchronously in its own atomic update group. Its writes
 * batch until the normal flush and can commit while unrelated work waits
 * on async. Async work triggered by the group holds it normally; shared
 * derivations and writes to held state can entangle it with other groups.
 * Nested calls start separate groups. The scope ends when `fn` returns,
 * including when it returns a promise; throws do not roll back writes.
 */
export function independent(fn: () => void): void {
  if (!hooks._active) {
    ambient = flushTransaction;
    // Materialize ordinary store backings staged before the first call;
    // subsequent grouped staging supplies its container immediately.
    storeParkHook?.(ensure(null));
    setFlushTransaction(ambient);
    hooks._active = true;
  }
  const t = newTransaction(false);
  independentGroups.add(t);
  t._open++;
  const previous = enter(t);
  try {
    fn();
  } finally {
    resolveTx(t)._open--;
    exit(previous);
    schedule();
  }
}
