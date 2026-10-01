import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { EXTERNAL_ACCOUNT_BRIDGE_CAPABILITY } from '../../shared/protocol-version'
import {
  ExternalAccountBridgeParams,
  type ExternalAccountBridgeResult
} from '../../shared/external-account-bridge'
import type { RuntimeStatus } from '../../shared/runtime-types'

function privateDirectory(path: string): void {
  const stat = lstatSync(dirname(path))
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Bridge files must be inside a private directory owned by this user (mode 0700).'
    )
  }
}

export const ACCOUNT_BRIDGE_HANDLERS: Record<string, CommandHandler> = {
  'account bridge': async (ctx) => {
    rejectRemoteSelectionFlags(
      ctx.flags,
      '`orca account bridge`. Run it on the account execution host.'
    )
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new RuntimeClientError(
        'invalid_environment',
        'The account bridge requires macOS or native Linux.'
      )
    }
    const input = ctx.flags.get('input')
    const output = ctx.flags.get('output')
    if (
      typeof input !== 'string' ||
      typeof output !== 'string' ||
      !isAbsolute(input) ||
      !isAbsolute(output)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use --input and --output with absolute private file paths.'
      )
    }
    const status = await ctx.client.call<RuntimeStatus>('status.get')
    if (!status.result.capabilities?.includes(EXTERNAL_ACCOUNT_BRIDGE_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update or restart Orca: this runtime does not support the external account bridge.'
      )
    }
    privateDirectory(input)
    privateDirectory(output)
    const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW)
    let request
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 128 * 1024
      ) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Bridge input must be a private regular file (mode 0600), at most 128 KiB.'
        )
      }
      try {
        request = ExternalAccountBridgeParams.parse(JSON.parse(readFileSync(fd, 'utf-8')))
      } catch {
        throw new RuntimeClientError('invalid_argument', 'Invalid account bridge request.')
      }
    } finally {
      closeSync(fd)
    }
    // Why: reserve the output before mutation. A retry must never truncate an older credential recovery file.
    const outputFd = openSync(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      const result = await ctx.client.call<ExternalAccountBridgeResult>('accounts.bridge', request)
      writeFileSync(outputFd, JSON.stringify(result.result))
      printResult(
        { ...result, result: { status: result.result.status, written: true } },
        ctx.json,
        (receipt) => `Account bridge: ${receipt.status}`
      )
    } finally {
      closeSync(outputFd)
    }
  }
}
