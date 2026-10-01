import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGlobalSettingsFixture } from '../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../shared/global-settings-types'
import { ClaudeManagedAuthStorage } from './claude-accounts/claude-managed-auth-storage'
import { ClaudeExternalAccountBridge } from './claude-accounts/claude-external-account-bridge'
import { CodexManagedHomePath } from './codex-accounts/codex-managed-home-path'
import { CodexManagedHomeLifecycle } from './codex-accounts/codex-managed-home-lifecycle'
import { CodexExternalAccountBridge } from './codex-accounts/codex-external-account-bridge'
import { externalCredentialDigest } from './external-account-credentials'
import {
  reserveExternalAccountRefresh,
  finishExternalAccountRefresh,
  assertExternalAccountCommandAllowed,
  beginExternalAccountLaunch,
  externalAccountReservationMatches,
  externalAccountRefreshOwnerToken
} from './external-account-refresh-reservation'
import { isExternallyManagedHome } from './rate-limits/external-account-usage'

const state = vi.hoisted(() => ({
  root: '',
  live: false,
  keychain: new Map<string, string>(),
  failDelete: false
}))
vi.mock('../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => state.root })
}))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('./claude-accounts/keychain', () => ({
  readManagedClaudeKeychainCredentials: async (id: string) => state.keychain.get(id) ?? null,
  writeManagedClaudeKeychainCredentials: async (id: string, value: string) => {
    state.keychain.set(id, value)
  },
  deleteManagedClaudeKeychainCredentials: async (id: string) => {
    if (state.failDelete) {
      throw new Error('Keychain denied')
    }
    state.keychain.delete(id)
  }
}))
vi.mock('../shared/process-table-snapshot-reader', () => ({
  getFreshProcessTableSnapshot: async () =>
    state.live ? [{ command: 'codex' }, { command: 'claude' }] : []
}))

function fixtures() {
  let settings = createGlobalSettingsFixture({ workspaceDir: state.root })
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
  const selected = (agent: 'claude' | 'codex', id: string | null) => {
    if (agent === 'claude') {
      store.updateSettings({ activeClaudeManagedAccountId: id })
    } else {
      store.updateSettings({ activeCodexManagedAccountId: id })
    }
    return { accounts: [], activeAccountId: id }
  }
  const claude = new ClaudeExternalAccountBridge(
    store,
    new ClaudeManagedAuthStorage(),
    {
      syncForCurrentSelection: async () => {},
      clearLastWrittenCredentialsJson: () => {},
      getRuntimeConfigDir: () => join(state.root, 'runtime-claude')
    },
    { select: async (id) => selected('claude', id) }
  )
  const paths = new CodexManagedHomePath(() => {
    throw new Error('WSL must never be used')
  })
  const codex = new CodexExternalAccountBridge(
    store,
    paths,
    new CodexManagedHomeLifecycle(paths),
    { clearLastWrittenAuthJson: () => {} },
    {
      select: async (id) => selected('codex', id)
    },
    {
      readForManagedHome: () => null,
      assertOAuthAccountAddAllowed: () => {},
      safeSyncIntoManagedHome: () => {}
    }
  )
  return { store, claude, codex }
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-external-bridge-'))
  state.live = false
  state.failDelete = false
  state.keychain.clear()
})
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
})

describe.each(['claude', 'codex'] as const)('%s external account storage', (agent) => {
  function credentials(token: string) {
    const claims = Buffer.from(JSON.stringify({ email: 'team@example.com' })).toString('base64url')
    return agent === 'claude'
      ? { claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh` } }
      : {
          tokens: {
            id_token: `header.${claims}.signature`,
            account_id: 'provider-a',
            access_token: token,
            refresh_token: `${token}-refresh`
          }
        }
  }
  const request = (token: string, expectedDigest: string | null = null) => ({
    operation: 'sync' as const,
    agent,
    key: 'server:lease-1',
    email: 'team@example.com',
    providerAccountId: 'provider-a',
    credentials: credentials(token),
    expectedDigest,
    activate: true
  })

  it('creates one owned slot, retries idempotently, and checks identity', async () => {
    const fixture = fixtures()
    const bridge = fixture[agent]
    const first = await bridge.handle(request('first'))
    const repeated = await bridge.handle(request('first'))
    expect(first.accountId).toBe(repeated.accountId)
    expect(first.active).toBe(true)
    expect(first.digest).toBe(externalCredentialDigest(credentials('first')))
    expect(
      fixture.store.getSettings().claudeManagedAccounts.length +
        fixture.store.getSettings().codexManagedAccounts.length
    ).toBe(1)
    await expect(
      bridge.handle({ ...request('first'), providerAccountId: 'different' })
    ).rejects.toThrow(/identity/)
  })

  it('rejects stale writes and waits while agents are live', async () => {
    const bridge = fixtures()[agent]
    const first = await bridge.handle(request('first'))
    expect((await bridge.handle(request('stale', '0'.repeat(64)))).status).toBe('conflict')
    state.live = true
    expect((await bridge.handle(request('new', first.digest))).status).toBe('conflict')
    expect(
      (await bridge.handle({ operation: 'remove', agent, key: 'server:lease-1' })).status
    ).toBe('busy')
    state.live = false
    expect((await bridge.handle(request('new', first.digest))).status).toBe('ok')
  })

  it('retires credentials and selection while preserving histories and foreign bindings', async () => {
    const fixture = fixtures()
    const bridge = fixture[agent]
    await bridge.handle(request('first'))
    const profile =
      agent === 'claude'
        ? fixture.store.getSettings().claudeManagedAccounts[0].managedAuthPath
        : fixture.store.getSettings().codexManagedAccounts[0].managedHomePath
    mkdirSync(join(profile, 'sessions'))
    writeFileSync(join(profile, 'sessions', 'conversation.jsonl'), 'keep this history')
    expect(isExternallyManagedHome(profile)).toBe(true)
    expect(
      (await bridge.handle({ operation: 'read', agent, key: 'foreign' })).credentials
    ).toBeNull()
    expect(
      (await bridge.handle({ operation: 'remove', agent, key: 'server:lease-1' })).status
    ).toBe('ok')
    expect(readFileSync(join(profile, 'sessions', 'conversation.jsonl'), 'utf-8')).toBe(
      'keep this history'
    )
    expect(
      (await bridge.handle({ operation: 'remove', agent, key: 'server:lease-1' })).status
    ).toBe('ok')
    const accounts =
      agent === 'claude'
        ? fixture.store.getSettings().claudeManagedAccounts
        : fixture.store.getSettings().codexManagedAccounts
    expect(accounts[0].externalCredentialSource?.retired).toBe(true)
    await bridge.handle({ ...request('second'), key: 'server:lease-2' })
    await expect(bridge.handle(request('first'))).rejects.toThrow(/retired/)
    expect(
      (agent === 'claude'
        ? fixture.store.getSettings().claudeManagedAccounts
        : fixture.store.getSettings().codexManagedAccounts
      ).length
    ).toBe(2)
  })
})

it('reserves both launch paths, rejects overlap, and releases only the matching owner', () => {
  const token = reserveExternalAccountRefresh('codex', 'binding-a')
  expect(token).not.toBeNull()
  expect(reserveExternalAccountRefresh('codex', 'binding-b')).toBeNull()
  expect(() => assertExternalAccountCommandAllowed('codex', null)).toThrow(/renewing/)
  expect(() => assertExternalAccountCommandAllowed('codex', 'ssh-host')).not.toThrow()
  expect(finishExternalAccountRefresh('codex', 'binding-b', token ?? '')).toBe(false)
  expect(finishExternalAccountRefresh('codex', 'binding-a', token ?? '')).toBe(true)
  expect(() => assertExternalAccountCommandAllowed('codex', null)).not.toThrow()
})

it('keeps refresh admission closed through asynchronous launch setup and registration', () => {
  const finishLaunch = beginExternalAccountLaunch('codex', null)
  expect(reserveExternalAccountRefresh('codex', 'binding-a', true)).toBeNull()
  finishLaunch()
  finishLaunch()
  const token = reserveExternalAccountRefresh('codex', 'binding-a', true)
  expect(token).not.toBeNull()
  expect(externalAccountReservationMatches('codex', 'binding-a', token ?? '')).toBe(true)
  expect(() => beginExternalAccountLaunch('codex', null)).toThrow(/renewing/)
  expect(() => beginExternalAccountLaunch('codex', 'ssh')).not.toThrow()
  expect(readFileSync(join(state.root, 'ai-quota-codex-refresh.json'), 'utf-8')).toContain(token)
  expect(finishExternalAccountRefresh('codex', 'binding-a', token ?? '')).toBe(true)
  expect(externalAccountReservationMatches('codex', 'binding-a', token ?? '')).toBe(false)
})

it.skipIf(process.platform !== 'darwin')(
  'does not report cleanup when Keychain deletion fails',
  async () => {
    const fixture = fixtures()
    await fixture.claude.handle({
      operation: 'sync',
      agent: 'claude',
      key: 'cleanup',
      email: 'test@example.com',
      providerAccountId: 'account',
      credentials: { claudeAiOauth: { accessToken: 'fake' } },
      expectedDigest: null,
      activate: false
    })
    state.failDelete = true
    await expect(
      fixture.claude.handle({ operation: 'remove', agent: 'claude', key: 'cleanup' })
    ).rejects.toThrow(/Keychain denied/)
    expect(
      fixture.store.getSettings().claudeManagedAccounts[0].externalCredentialSource?.retired
    ).not.toBe(true)
  }
)

it('recovers a durable owner after a lost acquire reply and retries completion', async () => {
  const token = '12345678-1234-4321-8321-123456789012'
  writeFileSync(
    join(state.root, 'ai-quota-claude-refresh.json'),
    JSON.stringify({ key: 'lost-reply', token, durable: true }),
    { mode: 0o600 }
  )
  expect(externalAccountRefreshOwnerToken('claude', 'foreign')).toBeUndefined()
  expect(externalAccountRefreshOwnerToken('claude', 'lost-reply')).toBe(token)
  expect(reserveExternalAccountRefresh('claude', 'lost-reply', true, token)).toBe(token)
  expect(finishExternalAccountRefresh('claude', 'lost-reply', token)).toBe(true)
  expect(finishExternalAccountRefresh('claude', 'lost-reply', token)).toBe(true)
  expect(() => assertExternalAccountCommandAllowed('claude', null)).not.toThrow()
})

it('loads completed durable ownership after restart without blocking launches', () => {
  writeFileSync(
    join(state.root, 'ai-quota-codex-refresh.json'),
    JSON.stringify({
      key: 'completed',
      token: '12345678-1234-4321-8321-123456789012',
      durable: true,
      finished: true
    }),
    { mode: 0o600 }
  )
  expect(() => assertExternalAccountCommandAllowed('codex', null)).not.toThrow()
  expect(
    finishExternalAccountRefresh('codex', 'completed', '12345678-1234-4321-8321-123456789012')
  ).toBe(true)
})
