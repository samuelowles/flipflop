// Shared probe vocabulary. Deliberately two functions and nothing else — no
// assertion library, no framework. A probe passes by returning, fails by
// throwing a plain Error, and skips by throwing one of these.

/** Build the error a probe throws to SKIP rather than FAIL. */
export function skip(reason) {
  const err = new Error(reason);
  err.skip = true;
  return err;
}

/** Throw a plain Error when the condition does not hold. */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
