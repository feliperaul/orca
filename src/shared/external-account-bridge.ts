import { z } from 'zod'

const BridgeIdentity = z
  .object({
    agent: z.enum(['claude', 'codex']),
    key: z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/)
  })
  .strict()

export const ExternalAccountBridgeParams = z.discriminatedUnion('operation', [
  BridgeIdentity.extend({ operation: z.literal('read') }),
  BridgeIdentity.extend({ operation: z.literal('remove'), reservationToken: z.uuid().optional() }),
  BridgeIdentity.extend({
    operation: z.literal('reserveRefresh'),
    reservationToken: z.uuid().optional(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  BridgeIdentity.extend({ operation: z.literal('finishRefresh'), reservationToken: z.uuid() }),
  BridgeIdentity.extend({
    operation: z.literal('sync'),
    email: z.email(),
    providerAccountId: z.string().min(1).max(512),
    credentials: z.record(z.string(), z.unknown()),
    expectedDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    activate: z.boolean().default(false),
    reservationToken: z.uuid().optional()
  }).strict()
])

export type ExternalAccountBridgeRequest = z.infer<typeof ExternalAccountBridgeParams>
export type ExternalAccountStorageRequest = Exclude<
  ExternalAccountBridgeRequest,
  { operation: 'reserveRefresh' | 'finishRefresh' }
>
export type ExternalAccountBinding = {
  manager: 'ai-quota'
  key: string
  providerAccountId: string
  retired?: boolean
}
export type ExternalAccountBridgeResult = {
  status: 'ok' | 'conflict' | 'busy'
  reservationToken?: string
  accountId: string | null
  credentials: Record<string, unknown> | null
  digest: string | null
  active: boolean
  refreshAllowed: boolean
  profilePath: string | null
}
