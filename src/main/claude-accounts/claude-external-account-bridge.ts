import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExternalAccountStorageRequest,
  ExternalAccountBridgeResult
} from '../../shared/external-account-bridge'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { externalAccountRefreshAllowed } from '../external-account-refresh-admission'
import type { Store } from '../persistence'
import {
  externalCredentialDigest,
  externalLogin,
  externalStoredLogin,
  parseExternalCredentials
} from '../external-account-credentials'
import type { ClaudeManagedAuthStorage } from './claude-managed-auth-storage'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelection } from './claude-account-selection'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'

export class ClaudeExternalAccountBridge {
  constructor(
    private readonly store: Pick<Store, 'getSettings' | 'updateSettings'>,
    private readonly storage: ClaudeManagedAuthStorage,
    private readonly runtime: Pick<
      ClaudeRuntimeAuthService,
      'syncForCurrentSelection' | 'clearLastWrittenCredentialsJson' | 'getRuntimeConfigDir'
    >,
    private readonly selection: Pick<ClaudeAccountSelection, 'select'>
  ) {}

  async handle(request: ExternalAccountStorageRequest): Promise<ExternalAccountBridgeResult> {
    const account = this.store
      .getSettings()
      .claudeManagedAccounts.find(
        (entry) =>
          entry.externalCredentialSource?.manager === 'ai-quota' &&
          entry.externalCredentialSource.key === request.key
      )
    if (account && account.managedAuthRuntime === 'wsl') {
      throw new Error('The account bridge supports the native host runtime only.')
    }
    if (request.operation === 'remove') {
      if (account) {
        const current = await this.read(account)
        if (!current.refreshAllowed) {
          return { ...current, status: 'busy' }
        }
        if (current.active) {
          await this.selection.select(null, { runtime: 'host' })
        }
        const snapshot = await this.storage.readBridgeSnapshot(account.id, account.managedAuthPath)
        const original = snapshot.credentialsJson
          ? parseExternalCredentials(snapshot.credentialsJson)
          : {}
        delete original.claudeAiOauth
        await (Object.keys(original).length
          ? this.storage.writeCredentials(
              account.id,
              account.managedAuthPath,
              JSON.stringify(original)
            )
          : this.storage.restoreCredentials(
              account.id,
              account.managedAuthPath,
              { credentialsJson: null, oauthAccountJson: snapshot.oauthAccountJson },
              true
            ))
        const removed = await this.storage.readBridgeSnapshot(account.id, account.managedAuthPath)
        if (externalStoredLogin('claude', removed.credentialsJson)) {
          throw new Error('Claude OAuth removal could not be verified.')
        }
        this.store.updateSettings({
          claudeManagedAccounts: this.store.getSettings().claudeManagedAccounts.map((entry) =>
            entry.id === account.id
              ? {
                  ...entry,
                  externalCredentialSource: {
                    manager: 'ai-quota',
                    key: request.key,
                    providerAccountId: account.externalCredentialSource?.providerAccountId ?? '',
                    retired: true
                  }
                }
              : entry
          )
        })
      }
      return this.read(undefined)
    }
    const current = await this.read(account)
    if (request.operation === 'read') {
      return current
    }
    if (account?.externalCredentialSource?.retired) {
      throw new Error(
        'This binding was retired. Acquire a new lease before installing credentials.'
      )
    }
    const incoming = externalLogin('claude', request.credentials)
    if (
      account &&
      (account.externalCredentialSource?.providerAccountId !== request.providerAccountId ||
        account.email !== request.email)
    ) {
      throw new Error(
        'A managed account binding cannot change identity. Remove it before creating a new binding.'
      )
    }
    const incomingDigest = externalCredentialDigest(incoming)
    if (
      (current.digest !== request.expectedDigest || (account && !current.refreshAllowed)) &&
      current.digest !== incomingDigest
    ) {
      return { ...current, status: 'conflict' }
    }
    let target = account
    if (!target) {
      if (
        findDuplicateClaudeAccount(
          this.store
            .getSettings()
            .claudeManagedAccounts.filter((entry) => !entry.externalCredentialSource?.retired),
          {
            email: request.email,
            organizationUuid: request.providerAccountId.split('/')[1] ?? null,
            managedAuthRuntime: 'host',
            wslDistro: null
          }
        )
      ) {
        throw new Error(
          'This Claude account already exists in Orca. The bridge will not take ownership of a personal account.'
        )
      }
      const id = randomUUID()
      const location = await this.storage.create(id, { runtime: 'host' })
      const now = Date.now()
      target = {
        id,
        ...location,
        email: request.email,
        authMethod: 'subscription-oauth',
        organizationUuid: request.providerAccountId.split('/')[1] ?? null,
        organizationName: null,
        externalCredentialSource: {
          manager: 'ai-quota',
          key: request.key,
          providerAccountId: request.providerAccountId
        },
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }
      try {
        writeFileSync(join(target.managedAuthPath, '.orca-external-account'), 'ai-quota\n', {
          mode: 0o600
        })
        await this.storage.writeAuth(id, target.managedAuthPath, {
          credentialsJson: JSON.stringify(incoming),
          oauthAccount: {
            accountUuid: request.providerAccountId.split('/')[0],
            emailAddress: request.email,
            organizationUuid: target.organizationUuid
          }
        })
        this.store.updateSettings({
          claudeManagedAccounts: [...this.store.getSettings().claudeManagedAccounts, target]
        })
      } catch (error) {
        await this.storage.remove(id, target.managedAuthPath)
        throw error
      }
    } else if (current.digest !== incomingDigest) {
      const targetId = target.id
      const latest = await this.storage.readBridgeSnapshot(target.id, target.managedAuthPath)
      const latestLogin = externalStoredLogin('claude', latest.credentialsJson)
      if ((latestLogin ? externalCredentialDigest(latestLogin) : null) !== current.digest) {
        return { ...(await this.read(target)), status: 'conflict' }
      }
      await this.storage.writeCredentials(
        target.id,
        target.managedAuthPath,
        JSON.stringify(incoming)
      )
      this.runtime.clearLastWrittenCredentialsJson(target.id)
      this.store.updateSettings({
        claudeManagedAccounts: this.store
          .getSettings()
          .claudeManagedAccounts.map((entry) =>
            entry.id === targetId ? { ...entry, updatedAt: Date.now() } : entry
          )
      })
      await this.runtime.syncForCurrentSelection({ runtime: 'host' })
    }
    if (request.activate && this.store.getSettings().activeClaudeManagedAccountId !== target.id) {
      await this.selection.select(target.id, { runtime: 'host' })
    }
    const result = await this.read(target)
    if (result.digest !== incomingDigest) {
      return { ...result, status: 'conflict' }
    }
    return result
  }

  private async read(
    account: ClaudeManagedAccount | undefined
  ): Promise<ExternalAccountBridgeResult> {
    const active = Boolean(
      account && this.store.getSettings().activeClaudeManagedAccountId === account.id
    )
    if (active) {
      await this.runtime.syncForCurrentSelection({ runtime: 'host' })
    }
    const refreshAllowed = await externalAccountRefreshAllowed('claude')
    const snapshot = account
      ? await this.storage.readBridgeSnapshot(account.id, account.managedAuthPath)
      : null
    const credentials = externalStoredLogin('claude', snapshot?.credentialsJson ?? null)
    return {
      status: 'ok',
      accountId: account?.id ?? null,
      credentials,
      digest: credentials ? externalCredentialDigest(credentials) : null,
      active,
      refreshAllowed,
      profilePath: account ? this.runtime.getRuntimeConfigDir({ runtime: 'host' }) : null
    }
  }
}
