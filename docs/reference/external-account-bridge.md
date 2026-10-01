# External subscription account bridge

The local public CLI exposes `orca account bridge --input /absolute/private/request.json
--output /absolute/private/result.json --json`. Linux installations typically expose the
same CLI as `orca-ide`. Both CLI and runtime must support `accounts.external-bridge.v1`.

Input and output parents must be private directories owned by the current user (0700).
Input must be a regular non-symlink file, 0600, at most 128 KiB. The output is created
exclusively with 0600; an existing output is preserved. Standard output contains only a
receipt. OAuth never travels in command arguments, standard output or error messages.
The RPC is rejected for remote/mobile clients and remote-selection flags. Native macOS
and Linux hosts are supported; SSH execution needs a bridge on the execution host.

The strict schema is in `src/shared/external-account-bridge.ts`. Every operation requires
`agent` (`claude` or `codex`) and a stable manager `key`. Operations:

- `read`: owned credentials, canonical SHA256 digest and launch/refresh admission.
- `sync`: immutable email/provider account identity, credentials, expected digest, optional
  activation and reservation token. A stale digest conflicts rather than overwriting a
  CLI refresh. The account service serializes mutation through its existing queue.
- `remove`: removes owned OAuth and selection, retains history/configuration and a retired
  ownership record. An active agent defers removal. Retired keys cannot be resurrected.
- `reserveRefresh`: expected digest, optional existing owner token. Refuses active processes
  and launches in progress; stores durable ownership before returning a private token.
- `finishRefresh`: owner token. A completed ownership record makes lost acknowledgments
  retryable. There is no timeout that silently reopens launches during a token rotation.

`read` returns an active reservation token only for the matching binding. This recovers a
lost acquisition response. Repeat `reserveRefresh` with that token to resume the same
operation. `sync`/`remove` accept that token; an expired, foreign or finished token cannot
bypass mutation admission. A read after completion lets the client discard a stale token.
Uncertain refreshes remain blocked until the manager reconciles or removes its profile;
operators must preserve recovery files and use the owning manager to recover/release.

Claude uses managed Keychain items on macOS and owned credentials files on Linux; removal
is strict and read back. Codex uses its owned `auth.json` with the existing OAuth/file
storage policy. The bridge refuses to claim matching personal accounts or WSL profiles.
The manager marker suppresses Orca's independent quota probes and automatic refresh;
quota readings come from the manager. Provider CLIs still authenticate directly with
OAuth and can refresh their own stored token; the manager reads and reconciles that pair.
Existing sessions cannot be assumed to switch login when selection or disk contents change.
