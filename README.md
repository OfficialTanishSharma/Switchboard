<div align="center">

# 🔀 Switchboard — Local AI Gateway

### *One local gateway. Every provider. Zero dependencies.*

![Node](https://img.shields.io/badge/node-≥20-339933)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-v2.4.0%20live-success)

Switchboard is a dependency-free Node.js gateway that runs on your own machine.
Paste your provider keys into a local dashboard, build ordered fallback combos, and point
Claude Code (or any Anthropic/OpenAI/Gemini client) at **one** URL — Switchboard translates
the protocols, encrypts the credentials, and reroutes automatically when a provider dies.

[Quick Start](#-quick-start) · [Dashboard](#-dashboard) · [Security Model](#-security-model) · [Providers](#-providers) · [Roadmap](#-roadmap)

</div>

---

## ✨ Features

- 🔌 **Zero dependencies** — pure Node.js (`http`, `crypto`, `fs`). No database, no native add-ons, no `node_modules` bloat.
- 🧩 **Protocol translation** — Anthropic ⇄ OpenAI ⇄ native Gemini, with real SSE streaming in both directions.
- 🎛 **Dashboard at `http://127.0.0.1:3141`** — add providers, test keys, fetch models, build combos, all from the browser. No env vars, ever.
- 🔐 **AES-256-GCM encrypted credentials** — keys are encrypted before they touch disk, and the dashboard never returns key material (plaintext or encrypted).
- 🔁 **Ordered fallback combos** — provider #1 down? Switchboard walks the combo automatically, mid-request if needed.
- 🤖 **Claude Code ready** — `switchboard-claude` launches the Claude CLI against the gateway with a harmless dummy key that is **never** forwarded upstream.
- 🛰 **Streaming reliability (v2.4.0)** — 60s connection timeout + resettable 180s stream-idle watchdog, so long coding responses keep flowing while chunks arrive.
- 📡 JSON-as-response from strict streamers is converted into valid Anthropic/OpenAI SSE; established streams get protocol-level error events instead of silent ends.
- 🖥 **Human-designed UI** — persistent sidebar on desktop, compact icon bar on mobile, light/dark system theme.
- 🗂 **Per-user config** — state lives in `%APPDATA%\Switchboard` (Windows) / `~/.config/switchboard` (Linux), not in the install folder.

---

## 🚀 Quick Start

### Option A — Install from npm

```bash
npm install -g @rolbol/switchboard
```

### Option B — From source

```bash
git clone https://github.com/OfficialTanishSharma/Switchboard.git
cd Switchboard
npm install -g .
```

### Daily workflow — from any directory

```bash
switchboard            # start the gateway + open the dashboard
switchboard-claude     # in another terminal: Claude Code through the gateway
```

The banner confirms the listening address, dashboard URL, encryption status,
enabled providers and the active Claude route. Nothing else to configure.

### First run (2 minutes)

1. Run `switchboard` — the dashboard opens at **http://127.0.0.1:3141**
2. **Providers** → paste a real key (TokenRouter, Gemini, Anthropic, OpenRouter, Groq, NVIDIA…) → **Test & fetch models** (the key is encrypted locally before persistence)
3. **Combos** → create an ordered fallback combo
4. **Default Claude route** → pick the combo or a single provider model → **Save route**
5. Run `switchboard-claude`

---

## 🎛 Dashboard

| Area | What it does |
|---|---|
| **Providers** | Add / edit / re-test upstreams; protocol + resolved endpoint shown before testing |
| **Models** | Discovered per provider via key test — no hand-typed model lists |
| **Combos** | Ordered fallback chains used when a provider fails or rate-limits |
| **Claude route** | The default combo/model Claude Code gets served |
| **Client keys** | Local keys for non-Claude clients |
| **Activity** | Request log with status, latency and which provider answered |

Saved credentials can be retested without re-entering the key.

---

## 🛡 Security Model

Switchboard is **local-first by design**:

- Listens only on `127.0.0.1:3141` — never exposed to the network.
- Credentials accepted **only** through the loopback dashboard API.
- Encrypted with **AES-256-GCM** inside `switchboard-state.json`; the key lives in `switchboard.key` (generated automatically).
- The dashboard API never returns plaintext or encrypted provider keys.
- Claude's dummy `sk-ant-*` key is never forwarded upstream.
- No provider key, master key or model choice is ever read from environment variables.

### Config location

| OS | Path |
|---|---|
| Windows | `%USERPROFILE%\AppData\Roaming\Switchboard` |
| macOS | `~/Library/Application Support/Switchboard` |
| Linux | `~/.config/switchboard` |

Files: `switchboard-state.json` (encrypted), `switchboard.key`, `switchboard.log`.
> Back up the state file and the key **together** — encrypted credentials are unrecoverable without the matching key. And never commit any of them; `.gitignore` already excludes them.

---

## 📡 Providers

Validated bases built in:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| TokenRouter | `https://api.tokenrouter.com/v1` |

**Custom endpoints**: choose OpenAI-compatible, Anthropic or native Gemini protocol, then paste any base or full endpoint URL. Switchboard normalizes slashes, strips query strings, preserves path prefixes (`/api/v1`, `/openai/v1`, `/gateway/v1`, local proxies) and supports both `http://` local and `https://` remote. Credentials embedded in URLs and non-HTTP schemes are rejected — use the encrypted key field instead.

---

## 🏗 Project Structure

```
Switchboard/
├── server.js                 # The gateway: routing, translation, SSE, dashboard
├── claude-switchboard.js     # Claude Code wrapper (dummy key, local URL)
├── start-switchboard.cmd     # Windows launchers (no npm install needed)
├── start-claude.cmd
├── Start-Switchboard.ps1
├── Start-Claude.ps1
├── package.json              # bin: switchboard, switchboard-claude
├── README.md
├── LICENSE                   # MIT
└── SECURITY.md
```

Single-file server on purpose — read every line, nothing to audit through a dependency tree.

---

## 🌐 Global Commands

```
switchboard                 Start the gateway, print banner, open dashboard
switchboard --no-open       Start without opening a browser
switchboard --help          Command help
switchboard --version       Installed version
switchboard-claude          Start Claude Code against Switchboard
switchboard-claude [args]   Pass args straight to the Claude CLI
```

`switchboard-claude` auto-detects the Claude binary on `PATH` and native installer
locations (including `%USERPROFILE%\.local\bin\claude.exe`).

---

## 🔄 Updating / Uninstalling

```bash
npm install -g @rolbol/switchboard@latest   # per-user config is kept
npm uninstall -g @rolbol/switchboard        # delete %APPDATA%\Switchboard to wipe config
```

Legacy `switchboard-state.json` / `.key` / `.log` files beside an older `server.js`
are copied into the per-user directory on first launch when no newer files exist.

---

## 🗺 Roadmap

- [x] v2.4.0 — streaming watchdog, JSON→SSE conversion, protocol-level stream errors
- [ ] Request-level cost tracking per provider
- [ ] Combo health history chart in the dashboard
- [ ] More per-route policy options (max tokens caps, model aliases)

---

## 🤝 Contributing

1. Fork the repository
2. `git checkout -b feature/my-feature`
3. Keep the zero-dependency rule — the point of Switchboard is that `dependencies` stays `{}`
4. Never weaken the key redaction / loopback-only guarantees
5. Open a Pull Request

## 🐛 Reporting Issues

Open an [issue](https://github.com/OfficialTanishSharma/Switchboard/issues) with steps to
reproduce, your OS and Node version. For security vulnerabilities see [SECURITY.md](SECURITY.md) — don't open a public issue.

## 📄 License

MIT — free to use, modify, and share. See [LICENSE](LICENSE).

---

<div align="center">

**Built by RolBol** · [@RolBol7](https://x.com/RolBol7) · npm: [@rolbol/switchboard](https://www.npmjs.com/package/@rolbol/switchboard)

*Part of the RolBol stack: [Klip](https://github.com/OfficialTanishSharma/Klip) · [Zevion](https://github.com/OfficialTanishSharma/Zevion)*

</div>
