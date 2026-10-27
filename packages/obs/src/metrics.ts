/**
 * packages/obs/metrics — re-export shim.
 *
 * Metrics and Funnel live in the package entry for cohesion, but several
 * modules import them from './metrics' for readability. This keeps a single
 * definition rather than two drifting copies.
 */

export { Funnel, Metrics } from './index';
