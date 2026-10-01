import { createHash } from 'node:crypto'
import { z } from 'zod'

const ObjectValue = z.record(z.string(), z.unknown())

export function parseExternalCredentials(source: string): Record<string, unknown> {
  try {
    return ObjectValue.parse(JSON.parse(source))
  } catch {
    throw new Error('Managed account credentials are invalid JSON.')
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function externalCredentialDigest(credentials: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(credentials)))
    .digest('hex')
}

export function externalLogin(
  agent: 'claude' | 'codex',
  credentials: Record<string, unknown>
): Record<string, unknown> {
  const keys = agent === 'claude' ? ['claudeAiOauth'] : ['tokens', 'auth_mode', 'last_refresh']
  if (!ObjectValue.safeParse(credentials[keys[0]]).success) {
    throw new Error('The bridge requires subscription OAuth credentials.')
  }
  return Object.fromEntries(
    keys.filter((key) => key in credentials).map((key) => [key, credentials[key]])
  )
}

export function externalStoredLogin(
  agent: 'claude' | 'codex',
  source: string | null
): Record<string, unknown> | null {
  if (!source) {
    return null
  }
  const credentials = parseExternalCredentials(source)
  const key = agent === 'claude' ? 'claudeAiOauth' : 'tokens'
  return key in credentials ? externalLogin(agent, credentials) : null
}
