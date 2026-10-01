import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

export function isExternallyManagedHome(home: string | null | undefined): boolean {
  return Boolean(home && existsSync(join(home, '.orca-external-account')))
}

export function externalAccountUsage(provider: 'claude' | 'codex'): ProviderRateLimits {
  return {
    provider,
    status: 'unavailable',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Usage is coordinated by ai-quota. Open its dashboard for shared limits.'
  }
}
