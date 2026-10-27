/**
 * scripts/check-config — preflight validation, safe to run in CI.
 *
 * Ships with the repository configs, so it must pass on a fresh clone while
 * still reporting exactly which owner bindings remain. It makes no network
 * calls and touches no secrets: the point is to fail loudly *before* a deploy,
 * not to prove the chain is reachable.
 */

import { loadChainConfig, loadPolicy, unresolvedPolicyFields } from '../packages/config/src';

function main(): number {
  const chainPath = process.env['SOL_TEA_CHAIN_CONFIG'] ?? 'config/mainnet.solana.yaml';
  const policyPath = process.env['SOL_TEA_POLICY_CONFIG'] ?? 'config/policy.solana.yaml';

  let failures = 0;

  try {
    const chain = loadChainConfig(chainPath);
    const unresolvedChain: string[] = [];
    if (chain.chain.genesisHash === 'REQUIRED_OWNER_BINDING') unresolvedChain.push('chain.genesisHash');
    if (chain.executor.operatorPublicAddress === 'REQUIRED_OWNER_BINDING') {
      unresolvedChain.push('executor.operatorPublicAddress');
    }
    if (chain.executor.treasuryAddress === 'REQUIRED_OWNER_BINDING') {
      unresolvedChain.push('executor.treasuryAddress');
    }

    console.log(`[ok]   chain config valid: ${chainPath}`);
    console.log(`       pools: ${chain.market.pools.map((p) => p.address).join(', ')}`);
    console.log(`       chain.enabled: ${chain.chain.enabled}`);
    if (unresolvedChain.length > 0) {
      console.log(`[note] chain owner bindings outstanding: ${unresolvedChain.join(', ')}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`[fail] chain config: ${(error as Error).message}`);
  }

  try {
    const policy = loadPolicy(policyPath);
    const unresolved = unresolvedPolicyFields(policy);
    console.log(`[ok]   policy config valid: ${policyPath}`);
    if (unresolved.length > 0) {
      console.log(`[note] policy bindings outstanding (${unresolved.length}):`);
      for (const field of unresolved) console.log(`       - ${field}`);
      console.log('       engine will run observe-only until these are resolved');
    } else {
      console.log('[ok]   all policy bounds resolved');
    }
  } catch (error) {
    failures += 1;
    console.error(`[fail] policy config: ${(error as Error).message}`);
  }

  return failures === 0 ? 0 : 1;
}

process.exit(main());
