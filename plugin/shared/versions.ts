// agentbook's version numbers ("0.3.40"), as its plugin says them: agentbook-cli's and its page's alike.

export const isVersion = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && /^\d+(\.\d+)*$/.test(v);
// Whether version `a` ("0.3.20") is older than `b`, by each number in turn.
export function olderVersion(a: string, b: string): boolean {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
// The newest of the versions said, leaving out what isn't one, or null.
export function newestOf(...said: unknown[]): string | null {
  return said.filter(isVersion).reduce<string | null>((a, v) => (!a || olderVersion(a, v) ? v : a), null);
}
