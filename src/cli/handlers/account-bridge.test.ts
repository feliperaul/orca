import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCOUNT_BRIDGE_HANDLERS } from './account-bridge'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { EXTERNAL_ACCOUNT_BRIDGE_CAPABILITY } from '../../shared/protocol-version'

let directory = ''
let log: ReturnType<typeof vi.spyOn>
const call = vi.fn()
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-cli-bridge-'))
  chmodSync(directory, 0o700)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  call.mockReset().mockImplementation(async (method: string) => ({
    ok: true,
    id: 'test',
    _meta: { runtimeId: 'fixture' },
    result:
      method === 'status.get'
        ? { capabilities: [EXTERNAL_ACCOUNT_BRIDGE_CAPABILITY] }
        : {
            status: 'ok',
            credentials: { claudeAiOauth: { accessToken: 'fake-secret' } },
            digest: null,
            accountId: 'fixture',
            active: true,
            refreshAllowed: true,
            profilePath: directory
          }
  }))
})
afterEach(() => {
  log.mockRestore()
  rmSync(directory, { recursive: true, force: true })
})

function context(): HandlerContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only uses RuntimeClient.call, replaced by the isolated RPC mock.
  const client = { call } as unknown as RuntimeClient
  return {
    client,
    cwd: directory,
    json: true,
    flags: new Map([
      ['input', join(directory, 'input.json')],
      ['output', join(directory, 'output.json')]
    ])
  }
}
function input(): void {
  writeFileSync(
    join(directory, 'input.json'),
    JSON.stringify({ operation: 'read', agent: 'claude', key: 'server:lease' }),
    { mode: 0o600 }
  )
}

it('writes credential responses privately and prints only a receipt', async () => {
  input()
  await ACCOUNT_BRIDGE_HANDLERS['account bridge'](context())
  const output = join(directory, 'output.json')
  expect(JSON.parse(readFileSync(output, 'utf-8')).credentials.claudeAiOauth.accessToken).toBe(
    'fake-secret'
  )
  expect(statSync(output).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(log.mock.calls)).not.toContain('fake-secret')
  expect(call).toHaveBeenCalledWith('accounts.bridge', {
    operation: 'read',
    agent: 'claude',
    key: 'server:lease'
  })
})

it('rejects capability skew before reading credentials', async () => {
  call.mockResolvedValue({ result: { capabilities: [] } })
  await expect(ACCOUNT_BRIDGE_HANDLERS['account bridge'](context())).rejects.toThrow(
    /does not support/
  )
  expect(call).not.toHaveBeenCalledWith('accounts.bridge', expect.anything())
})

it('rejects remote selectors before contacting a runtime', async () => {
  const ctx = context()
  ctx.flags.set('environment', 'remote-host')
  await expect(ACCOUNT_BRIDGE_HANDLERS['account bridge'](ctx)).rejects.toThrow(/host/)
  expect(call).not.toHaveBeenCalled()
})

it('refuses public credential files and symlinks', async () => {
  input()
  chmodSync(join(directory, 'input.json'), 0o644)
  await expect(ACCOUNT_BRIDGE_HANDLERS['account bridge'](context())).rejects.toThrow(
    /private regular file/
  )
  rmSync(join(directory, 'input.json'))
  writeFileSync(join(directory, 'foreign.json'), '{}', { mode: 0o600 })
  symlinkSync(join(directory, 'foreign.json'), join(directory, 'input.json'))
  await expect(ACCOUNT_BRIDGE_HANDLERS['account bridge'](context())).rejects.toThrow()
  expect(existsSync(join(directory, 'output.json'))).toBe(false)
})

it('reserves output before mutation and never truncates a recovery file', async () => {
  input()
  writeFileSync(join(directory, 'output.json'), 'existing recovery', { mode: 0o600 })
  await expect(ACCOUNT_BRIDGE_HANDLERS['account bridge'](context())).rejects.toThrow()
  expect(readFileSync(join(directory, 'output.json'), 'utf-8')).toBe('existing recovery')
  expect(call).not.toHaveBeenCalledWith('accounts.bridge', expect.anything())
})
