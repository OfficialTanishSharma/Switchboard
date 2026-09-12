# Security Policy

## What Switchboard guarantees

- The gateway listens **only on `127.0.0.1:3141`** — it never binds to a network interface.
- Provider credentials are **encrypted with AES-256-GCM** before being written to disk.
- The dashboard API **never returns key material** — plaintext or encrypted.
- The dummy local key used by Claude Code is **never forwarded upstream**.
- No credentials are ever read from environment variables or printed in logs.

## Supported versions

| Version | Supported |
|---|---|
| 2.4.x | ✅ |
| < 2.3 | ❌ (legacy SQLite builds, unsupported) |

## Reporting a vulnerability

Open a **private** report instead of a public issue:

1. GitHub → [Security tab → Report a vulnerability](https://github.com/OfficialTanishSharma/Switchboard/security/advisories/new), or
2. X DM to [@RolBol7](https://x.com/RolBol7).

Include: Switchboard version (`switchboard --version`), Node version, OS, and steps to
reproduce. Expect a first response within a few days — this is a solo open-source project,
not a company, but real issues get fixed and credited.

## Safe usage checklist

- Keep the state directory private: `%USERPROFILE%\AppData\Roaming\Switchboard`
  (Windows) / `~/.config/switchboard` (macOS/Linux).
- Never commit or share `switchboard-state.json`, `switchboard.key` or `switchboard.log`.
- Back up `switchboard-state.json` and `switchboard.key` **together** — one without the
  other is worthless.
- If a machine is compromised, assume every provider key in the state file is exposed:
  rotate the real keys at the provider first, then re-enter them in the dashboard.
