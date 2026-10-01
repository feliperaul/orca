import {
  reserveExternalAccountRefresh,
  finishExternalAccountRefresh,
  externalAccountRefreshOwnerToken,
  externalAccountReservationMatches
} from '../external-account-refresh-reservation'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type {
  ExternalAccountBridgeRequest,
  ExternalAccountBridgeResult
} from '../../shared/external-account-bridge'
import type {
  CodexAccountService,
  CodexResetCreditRejectedBeforeProviderReason
} from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { RateLimitService } from '../rate-limits/service'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'

export type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type AccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexRateLimitResetRpcResult = {
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
} & (
  | { outcome: CodexRateLimitResetOutcome }
  | {
      status: 'rejectedBeforeProvider'
      retryDisposition: 'discardAttempt'
      reason: CodexResetCreditRejectedBeforeProviderReason
    }
)

export class RuntimeAccountController {
  private services: RuntimeAccountServices | null = null
  private commitMessageAgentEnvironment: CommitMessageAgentEnvironmentResolvers | null = null

  setServices(services: RuntimeAccountServices): void {
    this.services = services
  }

  async bridgeAccount(request: ExternalAccountBridgeRequest): Promise<ExternalAccountBridgeResult> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('The account bridge supports macOS and native Linux hosts.')
    }
    const services = this.requireServices()
    const service = request.agent === 'claude' ? services.claudeAccounts : services.codexAccounts
    const readRequest = { operation: 'read' as const, agent: request.agent, key: request.key }
    if (request.operation === 'read') {
      return {
        ...(await service.bridgeAccount(readRequest)),
        reservationToken: externalAccountRefreshOwnerToken(request.agent, request.key)
      }
    }
    if (request.operation === 'reserveRefresh') {
      const token = reserveExternalAccountRefresh(
        request.agent,
        request.key,
        true,
        request.reservationToken
      )
      if (!token) {
        return { ...(await service.bridgeAccount(readRequest)), status: 'busy' }
      }
      try {
        const current = await service.bridgeAccount(readRequest)
        if (
          !current.refreshAllowed ||
          current.digest !== request.expectedDigest ||
          !current.credentials
        ) {
          finishExternalAccountRefresh(request.agent, request.key, token)
          return {
            ...current,
            status: current.digest !== request.expectedDigest ? 'conflict' : 'busy'
          }
        }
        return { ...current, reservationToken: token }
      } catch (error) {
        finishExternalAccountRefresh(request.agent, request.key, token)
        throw error
      }
    }
    if (request.operation === 'finishRefresh') {
      const released = finishExternalAccountRefresh(
        request.agent,
        request.key,
        request.reservationToken
      )
      return { ...(await service.bridgeAccount(readRequest)), status: released ? 'ok' : 'conflict' }
    }
    if (
      !externalAccountReservationMatches(
        request.agent,
        request.key,
        request.operation === 'sync' || request.operation === 'remove'
          ? request.reservationToken
          : undefined
      )
    ) {
      return { ...(await service.bridgeAccount(readRequest)), status: 'busy' }
    }
    if (
      !(
        (request.operation === 'sync' || request.operation === 'remove') &&
        request.reservationToken
      )
    ) {
      const token = reserveExternalAccountRefresh(request.agent, request.key)
      if (!token) {
        return { ...(await service.bridgeAccount(readRequest)), status: 'busy' }
      }
      try {
        return await service.bridgeAccount(request)
      } finally {
        finishExternalAccountRefresh(request.agent, request.key, token)
      }
    }
    return service.bridgeAccount(request)
  }

  setCommitMessageAgentEnvironment(resolvers: CommitMessageAgentEnvironmentResolvers): void {
    this.commitMessageAgentEnvironment = resolvers
  }

  getCommitMessageAgentEnvironment(): CommitMessageAgentEnvironmentResolvers | undefined {
    return this.commitMessageAgentEnvironment ?? undefined
  }

  getClaudeConfigDirectory(target: ClaudeAccountSelectionTarget): string | null {
    return this.services?.claudeAccounts.getRuntimeConfigDir(target) ?? null
  }

  getSnapshot(): AccountsSnapshot {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireServices()
    return {
      claude: claudeAccounts.listAccounts(),
      codex: codexAccounts.listAccounts(),
      rateLimits: rateLimits.getState()
    }
  }

  async refreshForMobile(): Promise<void> {
    const { rateLimits } = this.requireServices()
    await Promise.allSettled([
      rateLimits.refresh(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  async refreshForMobileSubscriber(): Promise<void> {
    const { rateLimits } = this.requireServices()
    await Promise.allSettled([
      rateLimits.refreshIfStale(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  selectClaude(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.selectAccount(accountId)
  }

  selectCodex(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.selectAccount(accountId)
  }

  selectCodexForTarget(
    accountId: string | null,
    target: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.selectAccountForTarget(accountId, target)
  }

  async consumeCodexResetCredit(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexRateLimitResetRpcResult> {
    const { claudeAccounts, codexAccounts } = this.requireServices()
    const result = await codexAccounts.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    const snapshot = {
      claude: claudeAccounts.listAccounts(),
      codex: result.codex,
      rateLimits: result.rateLimits
    }
    if ('status' in result) {
      return {
        status: result.status,
        retryDisposition: result.retryDisposition,
        reason: result.reason,
        scope: result.scope,
        snapshot
      }
    }
    return { outcome: result.outcome, scope: result.scope, snapshot }
  }

  removeClaude(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.removeAccount(accountId)
  }

  addClaudeFromConfigDir(
    configDir: string,
    options?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
      previousLegacyCredentialsSha256?: string | null
    }
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.addAccountFromConfigDir(configDir, options)
  }

  removeCodex(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.removeAccount(accountId)
  }

  addCodexFromHome(
    sourceHome: string,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.addAccountFromHome(sourceHome, target)
  }

  onChanged(listener: (snapshot: AccountsSnapshot) => void): () => void {
    const services = this.requireServices()
    return services.rateLimits.onStateChange((rateLimits) => {
      listener({
        claude: services.claudeAccounts.listAccounts(),
        codex: services.codexAccounts.listAccounts(),
        rateLimits
      })
    })
  }

  private requireServices(): RuntimeAccountServices {
    if (!this.services) {
      throw new Error('Account services are not configured on this runtime')
    }
    return this.services
  }
}
