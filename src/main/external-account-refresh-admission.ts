import { recognizeAgentProcessFromCommandLine } from '../shared/agent-process-recognition'
import { getFreshProcessTableSnapshot } from '../shared/process-table-snapshot-reader'
import { hasLiveClaudePtys } from './claude-accounts/live-pty-gate'

export async function externalAccountRefreshAllowed(agent: 'claude' | 'codex'): Promise<boolean> {
  if (agent === 'claude' && hasLiveClaudePtys()) {
    return false
  }
  try {
    const rows = await getFreshProcessTableSnapshot()
    return !rows.some(
      (row) =>
        recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })
          ?.agent === agent
    )
  } catch {
    // Unknown liveness cannot admit a single-use token rotation.
    return false
  }
}
