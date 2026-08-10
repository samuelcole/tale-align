/**
 * Freeze a value and everything reachable through it, in place.
 *
 * Every value this library hands back is frozen on its way out the door, so a
 * caller who tries to edit a result *fails loudly* instead of quietly editing
 * a copy of the truth — the modules are all ESM, which is strict mode, so an
 * assignment to a frozen object throws a TypeError rather than being silently
 * dropped. It is the runtime half of the convention the source keeps: nothing
 * here reassigns a binding or mutates an object it did not just build.
 *
 * Only plain objects and arrays are walked. Buffers and other typed arrays are
 * returned untouched (freezing one throws — a view over a mutable buffer can't
 * honor it), and so is anything with a class prototype (a Map, a Date, a
 * cheerio node): freezing those breaks their own methods, which is a worse
 * bargain than the guarantee is worth. An already-frozen value is taken at its
 * word and not descended into.
 */
export function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    ArrayBuffer.isView(value) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return value;
  }
  // Freeze before descending: a structure that points back at itself then
  // stops on the second visit instead of recursing forever.
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
