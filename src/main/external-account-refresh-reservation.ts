import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../shared/app-environment'
import { z } from 'zod'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { recognizeAgentProcessFromCommandLine } from '../shared/agent-process-recognition'

type Agent = 'claude' | 'codex'
type Reservation = { key: string; token: string; durable: boolean; finished?: boolean }
const reservations = new Map<string, Reservation>()
const launching = new Map<Agent, number>()
const StoredReservation = z
  .object({
    key: z.string(),
    token: z.uuid(),
    durable: z.literal(true),
    finished: z.boolean().optional()
  })
  .strict()

function path(agent: Agent): string {
  return join(getAppEnvironment().getPath('userData'), `ai-quota-${agent}-refresh.json`)
}
function current(agent: Agent): Reservation | undefined {
  const file = path(agent)
  const cached = reservations.get(file)
  if (cached) {
    return cached.finished ? undefined : cached
  }
  if (!existsSync(file)) {
    return undefined
  }
  // A damaged ownership record must keep launches blocked until recovery.
  const stored = StoredReservation.parse(JSON.parse(readFileSync(file, 'utf-8')))
  reservations.set(file, stored)
  return stored.finished ? undefined : stored
}
export function reserveExternalAccountRefresh(
  agent: Agent,
  key: string,
  durable = false,
  ownerToken?: string
): string | null {
  const existing = current(agent)
  if (existing) {
    return durable && existing.key === key && existing.token === ownerToken ? existing.token : null
  }
  if (launching.get(agent)) {
    return null
  }
  const token = randomUUID()
  const reservation = { key, token, durable }
  if (durable) {
    writeFileAtomically(path(agent), JSON.stringify(reservation), { mode: 0o600 })
  }
  reservations.set(path(agent), reservation)
  return token
}
export function finishExternalAccountRefresh(agent: Agent, key: string, token: string): boolean {
  current(agent)
  const reservation = reservations.get(path(agent))
  if (!reservation || reservation.key !== key || reservation.token !== token) {
    return false
  }
  if (reservation.durable) {
    const completed = { ...reservation, finished: true }
    writeFileAtomically(path(agent), JSON.stringify(completed), { mode: 0o600 })
    reservations.set(path(agent), completed)
  } else {
    reservations.delete(path(agent))
  }
  return true
}
export function externalAccountReservationMatches(
  agent: Agent,
  key: string,
  token: string | undefined
): boolean {
  const reservation = current(agent)
  return token
    ? Boolean(reservation && reservation.key === key && reservation.token === token)
    : !reservation
}
export function assertExternalAccountLaunchAllowed(agent: Agent): void {
  if (current(agent)) {
    throw new Error(
      `ai-quota is renewing ${agent} credentials. Retry this launch after synchronization finishes.`
    )
  }
}
export function beginExternalAccountLaunch(
  command: string | null | undefined,
  connectionId: string | null | undefined,
  launchAgent?: string
): () => void {
  if (connectionId) {
    return () => {}
  }
  const agent =
    launchAgent ??
    recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })?.agent
  if (agent !== 'claude' && agent !== 'codex') {
    return () => {}
  }
  assertExternalAccountLaunchAllowed(agent)
  launching.set(agent, (launching.get(agent) ?? 0) + 1)
  let finished = false
  return () => {
    if (finished) {
      return
    }
    finished = true
    launching.set(agent, Math.max(0, (launching.get(agent) ?? 1) - 1))
  }
}
export function assertExternalAccountCommandAllowed(
  command: string | null | undefined,
  connectionId: string | null | undefined
): void {
  if (connectionId) {
    return
  }
  const agent = recognizeAgentProcessFromCommandLine(command, {
    includeHeadlessOneShot: true
  })?.agent
  if (agent === 'claude' || agent === 'codex') {
    assertExternalAccountLaunchAllowed(agent)
  }
}

export function externalAccountRefreshOwnerToken(agent: Agent, key: string): string | undefined {
  const owner = current(agent)
  return owner?.key === key ? owner.token : undefined
}
