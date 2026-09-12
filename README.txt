Switchboard AI Gateway 2.4.0

2.4.0 streaming reliability update
- Replaced the 60-second total stream deadline with a 60-second connection/header timeout and a resettable 180-second stream-idle watchdog.
- Long coding responses can continue beyond 60 seconds while upstream chunks are still arriving.
- Providers that return complete JSON despite a streaming request are converted into valid Anthropic/OpenAI SSE sequences.
- Established streams now return protocol-level error events instead of silently ending.

What you need
- Node.js 20 or newer
- Claude CLI, if you use Claude Code
- No npm dependencies, database, native add-ons, or API-key environment variables

Global installation from npm
After the package has been published under the @rolbol scope, anyone can install it from any directory:
   npm install -g @rolbol/switchboard

Local package installation
1. Extract this package and open one terminal in the extracted folder.
2. Register the same global commands without using the npm registry:
   npm install -g .
3. You can now launch Switchboard from any directory.

Daily workflow — from any directory
1. Start the gateway:
   switchboard
2. The professional SWITCHBOARD banner confirms:
   - Active listening address and port
   - Dashboard URL
   - AES-256-GCM encryption status
   - Number of enabled providers
   - Active Claude route
3. Switchboard automatically opens http://127.0.0.1:3141.
4. Start Claude through the clean wrapper in another terminal:
   switchboard-claude

No cd command, API-key export, PowerShell variable, bash variable, or model argument is required after installation.

First dashboard setup
1. Run switchboard.
2. In Providers, paste the real TokenRouter, Gemini, Anthropic, OpenRouter, Groq, NVIDIA, or custom-provider key.
3. Click Test & fetch models. The credential is encrypted locally before persistence.
4. In Combos, create an ordered fallback combo.
5. Under Default Claude route, select the combo or one provider model and click Save route.
6. Run switchboard-claude. It supplies only the local URL and harmless dummy key required by Claude CLI.

Human-designed dashboard
- A restrained, product-focused interface replaces the previous generic control panel.
- Desktop uses a persistent workspace sidebar; mobile uses a compact icon navigation bar.
- Provider status, model counts, routing, client keys, and request activity are separated into clear work areas.
- Light and dark themes follow the system preference and can be changed from the dashboard.
- Provider forms show the protocol and resolved endpoint shape before testing.
- Saved credentials can be retested without re-entering the key.

Validated provider bases
- OpenAI: https://api.openai.com/v1
- Anthropic: https://api.anthropic.com/v1
- Google AI Studio: https://generativelanguage.googleapis.com/v1beta
- OpenRouter: https://openrouter.ai/api/v1
- Groq: https://api.groq.com/openai/v1
- NVIDIA NIM: https://integrate.api.nvidia.com/v1
- TokenRouter: https://api.tokenrouter.com/v1

Custom upstream URLs
- Choose Custom endpoint in Providers.
- Select OpenAI compatible, Anthropic, or native Gemini protocol.
- Enter either a base URL or a complete models/chat/messages/generateContent endpoint.
- Switchboard removes duplicate slashes, strips query strings, recognizes full endpoint suffixes, and safely rebuilds the required route.
- Existing path prefixes are preserved, including /api/v1, /openai/v1, /gateway/v1, and local proxy paths.
- Both http:// local services and https:// remote gateways are supported.
- Credentials embedded in URLs and non-HTTP schemes are rejected; use the encrypted API key field instead.

Global commands
- switchboard                 Start Switchboard, print the banner, and open the dashboard
- switchboard --no-open       Start without opening a browser
- switchboard --help          Show command help
- switchboard --version       Print the installed version
- switchboard-claude          Auto-detect and start Claude Code against Switchboard
- switchboard-claude [args]   Pass arguments directly to Claude CLI

Alternative local launchers
- Windows Command Prompt: start-switchboard.cmd and start-claude.cmd
- Windows PowerShell: .\Start-Switchboard.ps1 and .\Start-Claude.ps1
- Direct local server: node server.js

In-app configuration guarantee
- Real upstream credentials are accepted only by the loopback-only dashboard API.
- Provider tests, discovered models, fallback combos, and the default Claude route are managed in the dashboard.
- The dashboard never returns plaintext or encrypted provider-key material.
- Claude's dummy local credential is never forwarded upstream.
- Credentials are encrypted with AES-256-GCM inside switchboard-state.json.
- The encryption key is generated automatically as switchboard.key.
- No provider key, upstream token, master key, or model choice is read from environment variables.
- Routine route activity is recorded in the dashboard rather than cluttering startup output.

Per-user configuration location
- Windows: %USERPROFILE%\AppData\Roaming\Switchboard
- macOS: ~/Library/Application Support/Switchboard
- Linux: ~/.config/switchboard

Files in that directory
- switchboard-state.json: encrypted providers, discovered models, combos, and default route
- switchboard.key: automatically generated encryption key
- switchboard.log: bounded asynchronous request history

Back up switchboard-state.json and switchboard.key together. Encrypted provider credentials cannot be recovered without the matching key.

Updating from npm
- Install the latest published release:
  npm install -g @rolbol/switchboard@latest
- Existing per-user configuration is retained automatically.

Updating from a downloaded package
1. Extract the newer package.
2. Open one terminal in that folder.
3. Run:
   npm install -g .

Publishing for the @rolbol scope owner
1. Sign in with an npm account that owns or can publish to the @rolbol scope:
   npm login
2. From the package folder, publish the public scoped package:
   npm publish

Uninstalling
- Remove global commands:
  npm uninstall -g @rolbol/switchboard
- Configuration remains in the per-user directory until you delete it manually.

Notes
- Switchboard listens only on 127.0.0.1:3141.
- Legacy switchboard-state.json, switchboard.key, and switchboard.log files beside server.js are copied into the per-user directory on first launch when no newer files exist.
- switchboard-claude automatically checks PATH and native Claude installer locations, including %USERPROFILE%\\.local\\bin\\claude.exe on Windows.
- No application can guarantee service through power loss, OS termination, hardware failure, or upstream outages. Recoverable request, stream, provider, routing, and log failures remain isolated and ordered fallbacks continue automatically.
