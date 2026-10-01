import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { externalAccountUsage, isExternallyManagedHome } from './external-account-usage'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import type { InactiveClaudeAccount } from './claude-managed-account-credentials'
import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import type {
  ClaudeManagedAccountUsageOptions,
  ClaudeRateLimitFetchOptions
} from './claude-usage-fetch-options'

export type FetchClaudeRateLimitsOptions = ClaudeRateLimitFetchOptions
export type FetchManagedAccountUsageOptions = ClaudeManagedAccountUsageOptions
export type InactiveClaudeAccountInfo = InactiveClaudeAccount

export async function fetchClaudeRateLimits(
  options?: FetchClaudeRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.authPreparation?.externallyManaged) {
    return externalAccountUsage('claude')
  }
  return fetchActiveClaudeRateLimits(options)
}

export async function fetchManagedAccountUsage(
  account: InactiveClaudeAccountInfo,
  options: FetchManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (isExternallyManagedHome(account.managedAuthPath)) {
    return externalAccountUsage('claude')
  }
  return fetchInactiveClaudeAccountUsage(account, options)
}
