import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readClaudeManagedAuthFile } from './managed-auth-path'
import { readManagedClaudeKeychainCredentials } from './keychain'
import type { ClaudeManagedAuthSnapshot } from './claude-managed-auth-storage'

export async function readClaudeBridgeSnapshot(
  accountId: string,
  managedAuthPath: string
): Promise<ClaudeManagedAuthSnapshot> {
  if (process.platform === 'darwin') {
    return {
      credentialsJson: await readManagedClaudeKeychainCredentials(accountId),
      oauthAccountJson: readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json')
    }
  }
  let fd: number
  try {
    fd = openSync(
      join(managedAuthPath, '.credentials.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        credentialsJson: null,
        oauthAccountJson: readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json')
      }
    }
    throw new Error('Claude managed credentials are temporarily unreadable.')
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('Claude managed credentials are not a regular file.')
    }
    return {
      credentialsJson: readFileSync(fd, 'utf-8'),
      oauthAccountJson: readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json')
    }
  } finally {
    closeSync(fd)
  }
}
