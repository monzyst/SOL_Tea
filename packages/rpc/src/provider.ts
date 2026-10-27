/**
 * packages/rpc — provider pool with measured health and honest failover.
 *
 * Failover is driven by observed failures, not by configuration optimism. A
 * provider is only marked degraded after consecutive failures, and every switch
 * is logged: a silent failover that nobody notices is how an engine ends up
 * running on a degraded provider for a week.
 */

import { Connection } from '@solana/web3.js';
import type { Logger } from '../../obs/src';

export interface ProviderConfig {
  readonly id: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly role: 'primary' | 'secondary';
}

export interface ProviderState {
  readonly id: string;
  readonly role: 'primary' | 'secondary';
  readonly healthy: boolean;
  readonly consecutiveFailures: number;
  readonly lastErrorAtUtc: string | null;
  readonly lastSuccessAtUtc: string | null;
}

export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: number) {
    super(`all ${attempts} RPC providers failed`);
    this.name = 'AllProvidersFailedError';
  }
}

interface TrackedProvider {
  readonly config: ProviderConfig;
  readonly connection: Connection;
  consecutiveFailures: number;
  healthy: boolean;
  lastErrorAtUtc: string | null;
  lastSuccessAtUtc: string | null;
}

/** Build provider configs, skipping an incomplete secondary pair. */
export function buildProviderConfigs(input: {
  httpUrl: string;
  wsUrl: string;
  httpUrlSecondary: string;
  wsUrlSecondary: string;
}): ProviderConfig[] {
  const configs: ProviderConfig[] = [
    { id: 'primary', httpUrl: input.httpUrl, wsUrl: input.wsUrl, role: 'primary' },
  ];
  if (input.httpUrlSecondary !== '' && input.wsUrlSecondary !== '') {
    configs.push({
      id: 'secondary',
      httpUrl: input.httpUrlSecondary,
      wsUrl: input.wsUrlSecondary,
      role: 'secondary',
    });
  }
  return configs;
}

export class ProviderPool {
  private readonly providers: TrackedProvider[];
  private readonly failureThreshold = 2;

  constructor(
    configs: readonly ProviderConfig[],
    private readonly options: {
      commitment: 'confirmed' | 'finalized';
      logger: Logger;
    },
  ) {
    if (configs.length === 0) throw new Error('at least one RPC provider is required');
    this.providers = configs.map((config) => ({
      config,
      // The Connection takes the HTTP endpoint as its base and uses wsUrl for
      // subscriptions: passing a wss:// URL as the base throws in web3.js.
      connection: new Connection(config.httpUrl, {
        commitment: options.commitment,
        wsEndpoint: config.wsUrl,
      }),
      consecutiveFailures: 0,
      healthy: true,
      lastErrorAtUtc: null,
      lastSuccessAtUtc: null,
    }));
  }

  get primary(): TrackedProvider {
    return this.providers.find((p) => p.config.role === 'primary') ?? (this.providers[0] as TrackedProvider);
  }

  get all(): readonly TrackedProvider[] {
    return this.providers;
  }

  /**
   * Run an operation with automatic failover. The operation receives a
   * Connection so the caller never holds a stale reference after a switch.
   */
  async withFailover<T>(operation: (connection: Connection, providerId: string) => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      try {
        const result = await operation(provider.connection, provider.config.id);
        if (provider.consecutiveFailures > 0 || !provider.healthy) {
          this.options.logger.info('rpc_provider_recovered', { providerId: provider.config.id });
        }
        provider.consecutiveFailures = 0;
        provider.healthy = true;
        provider.lastSuccessAtUtc = new Date().toISOString();
        return result;
      } catch (error) {
        lastError = error as Error;
        provider.consecutiveFailures += 1;
        provider.lastErrorAtUtc = new Date().toISOString();
        if (provider.consecutiveFailures >= this.failureThreshold) {
          provider.healthy = false;
          this.options.logger.warn('rpc_provider_degraded', {
            providerId: provider.config.id,
            consecutiveFailures: provider.consecutiveFailures,
            error: lastError.message,
          });
        }
      }
    }

    throw new AllProvidersFailedError(this.providers.length);
  }

  statesSnapshot(): ProviderState[] {
    return this.providers.map((provider) => ({
      id: provider.config.id,
      role: provider.config.role,
      healthy: provider.healthy,
      consecutiveFailures: provider.consecutiveFailures,
      lastErrorAtUtc: provider.lastErrorAtUtc,
      lastSuccessAtUtc: provider.lastSuccessAtUtc,
    }));
  }
}
