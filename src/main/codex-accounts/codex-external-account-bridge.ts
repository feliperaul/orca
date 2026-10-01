import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExternalAccountStorageRequest,
  ExternalAccountBridgeResult
} from '../../shared/external-account-bridge'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { externalAccountRefreshAllowed } from '../external-account-refresh-admission'
import type { Store } from '../persistence'
import {
  externalCredentialDigest,
  externalLogin,
  externalStoredLogin,
  parseExternalCredentials
} from '../external-account-credentials'
import { readCodexAuthIdentity } from './codex-auth-identity'
import type { CodexManagedHomePath } from './codex-managed-home-path'
import type { CodexManagedHomeLifecycle } from './codex-managed-home-lifecycle'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { CodexAccountSelection } from './codex-account-selection'
import type { CodexConfigMirror } from './codex-config-mirror'
import { writeFileAtomically } from './fs-utils'

export class CodexExternalAccountBridge {
  constructor(
    private readonly store: Pick<Store, 'getSettings' | 'updateSettings'>,
    private readonly paths: CodexManagedHomePath,
    private readonly homes: CodexManagedHomeLifecycle,
    private readonly runtime: Pick<CodexRuntimeHomeService, 'clearLastWrittenAuthJson'>,
    private readonly selection: Pick<CodexAccountSelection, 'select'>,
    private readonly config: Pick<
      CodexConfigMirror,
      'assertOAuthAccountAddAllowed' | 'readForManagedHome' | 'safeSyncIntoManagedHome'
    >
  ) {}

  async handle(request: ExternalAccountStorageRequest): Promise<ExternalAccountBridgeResult> {
    const account = this.store
      .getSettings()
      .codexManagedAccounts.find(
        (entry) =>
          entry.externalCredentialSource?.manager === 'ai-quota' &&
          entry.externalCredentialSource.key === request.key
      )
    if (account && account.managedHomeRuntime === 'wsl') {
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
        const home = this.paths.assert(account.managedHomePath, account.id)
        let original: Record<string, unknown> = {}
        try {
          original = parseExternalCredentials(readFileSync(join(home, 'auth.json'), 'utf-8'))
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error
          }
        }
        for (const key of ['tokens', 'auth_mode', 'last_refresh']) {
          delete original[key]
        }
        if (Object.keys(original).length) {
          writeFileAtomically(join(home, 'auth.json'), JSON.stringify(original), { mode: 0o600 })
        } else {
          rmSync(join(home, 'auth.json'), { force: true })
        }
        this.store.updateSettings({
          codexManagedAccounts: this.store.getSettings().codexManagedAccounts.map((entry) =>
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
    const incoming = externalLogin('codex', request.credentials)
    const identity = readCodexAuthIdentity(JSON.stringify(incoming))
    if (
      !identity?.email ||
      identity.email !== request.email ||
      identity.providerAccountId !== request.providerAccountId
    ) {
      throw new Error('Codex credentials do not match the requested subscription identity.')
    }
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
      const id = randomUUID()
      const location = await this.homes.create(id, { runtime: 'host' })
      const now = Date.now()
      target = {
        id,
        ...location,
        email: request.email,
        providerAccountId: identity.providerAccountId,
        workspaceAccountId: identity.workspaceAccountId,
        workspaceLabel: identity.workspaceLabel,
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
        this.config.assertOAuthAccountAddAllowed(
          this.config.readForManagedHome(location.managedHomePath)
        )
        this.config.safeSyncIntoManagedHome(location.managedHomePath, undefined, id)
        writeFileSync(join(location.managedHomePath, '.orca-external-account'), 'ai-quota\n', {
          mode: 0o600
        })
        writeFileAtomically(join(location.managedHomePath, 'auth.json'), JSON.stringify(incoming), {
          mode: 0o600
        })
        this.store.updateSettings({
          codexManagedAccounts: [...this.store.getSettings().codexManagedAccounts, target]
        })
      } catch (error) {
        this.homes.removeUnlessUnproven(error, location.managedHomePath, id)
        throw error
      }
    } else if (current.digest !== incomingDigest) {
      const targetId = target.id
      const home = this.paths.assert(target.managedHomePath, target.id)
      const existing = parseExternalCredentials(readFileSync(join(home, 'auth.json'), 'utf-8'))
      if (externalCredentialDigest(externalLogin('codex', existing)) !== current.digest) {
        return { ...(await this.read(target)), status: 'conflict' }
      }
      writeFileAtomically(join(home, 'auth.json'), JSON.stringify({ ...existing, ...incoming }), {
        mode: 0o600
      })
      this.runtime.clearLastWrittenAuthJson(target.id)
      this.store.updateSettings({
        codexManagedAccounts: this.store
          .getSettings()
          .codexManagedAccounts.map((entry) =>
            entry.id === targetId ? { ...entry, updatedAt: Date.now() } : entry
          )
      })
    }
    if (request.activate && this.store.getSettings().activeCodexManagedAccountId !== target.id) {
      await this.selection.select(target.id, { runtime: 'host' })
    }
    const result = await this.read(target)
    return result.digest === incomingDigest ? result : { ...result, status: 'conflict' }
  }

  private async read(
    account: CodexManagedAccount | undefined
  ): Promise<ExternalAccountBridgeResult> {
    const refreshAllowed = await externalAccountRefreshAllowed('codex')
    const home = account ? this.paths.assert(account.managedHomePath, account.id) : null
    let source: string | null = null
    if (home) {
      try {
        source = readFileSync(join(home, 'auth.json'), 'utf-8')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw new Error('Codex managed credentials are temporarily unreadable.')
        }
      }
    }
    const credentials = externalStoredLogin('codex', source)
    return {
      status: 'ok',
      accountId: account?.id ?? null,
      credentials,
      digest: credentials ? externalCredentialDigest(credentials) : null,
      active: Boolean(
        account && this.store.getSettings().activeCodexManagedAccountId === account.id
      ),
      refreshAllowed,
      profilePath: home
    }
  }
}
