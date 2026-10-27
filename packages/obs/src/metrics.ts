/**
 * packages/obs/metrics — in-process counters/gauges rendered for /healthz.
 *
 * Deliberately dependency-free: a Prometheus client is an operational choice,
 * not a Phase-1 requirement (V6 §02 forbids mandatory observability clusters).
 */

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      gauges: Object.fromEntries([...this.gauges.entries()].sort()),
    };
  }
}
