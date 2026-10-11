# Codex Telegram Bridge

A private Telegram bot that connects to the Codex app-server daemon already running on this Windows account.

## Requirements

- Windows with Node.js 22.21 or newer.
- Codex CLI installed and signed in.
- The Codex app-server daemon running under the same Windows account.
- A Telegram bot token from `@BotFather`.

The Bridge uses Telegram long polling and a local Codex control socket. It does not open a public port.
On Windows, the start script reads the current user's proxy settings when `HTTP_PROXY` and `HTTPS_PROXY` are not set, and configures Node.js to use that proxy while keeping localhost traffic direct.

## First connection

1. In Telegram, open `@BotFather`, run `/newbot`, and follow its prompts. Keep the token private.
2. In PowerShell, go to this project directory and save the token with the hidden prompt:

   ```powershell
   .\scripts\save-token.ps1
   ```

   Windows encrypts the token for the current account with DPAPI and stores it under `.runtime`.
3. Start the Bridge:

   ```powershell
   .\scripts\start.ps1
   ```

   The terminal prints a one-time pairing code. It expires after 20 minutes.
4. Open your new bot in Telegram, press **Start**, then send `/pair YOUR_CODE` using the code shown in PowerShell.
5. Send `/help`, then `/new` to create a Codex session. Sending `/new Topic name` creates a Telegram topic when private Topics are enabled.

The Bridge binds to the first Telegram user that successfully pairs. It ignores messages from other accounts and all group chats.

## Commands

- `/new [topic name]` — create a Codex session and, when available, a private Telegram topic.
- `/history` — browse recent Codex sessions and resume one in the current topic.
- `/search words` — search saved Codex session history.
- `/open THREAD_ID` — resume a session by ID.
- `/model` — choose from the local proxy's live `/v1/models` response.
- `/permission` — select read-only, project-write, or fully unrestricted access.
- `/status` — show the current thread, model, workspace, and permission.
- `/stop` — interrupt the active Codex turn.
- `/cwd [path]` — view or change the working directory.
- `/rename name` — rename the current session.
- `/archive` — archive the current session.
- `/fork [topic]` — fork the session to a new topic.
- `/compact` — compact session history to reduce token usage.
- `/effort` — set reasoning effort level (low/medium/high/ultra).
- Send text or an image to start a Codex turn.

The default workspace and model-list endpoint are in `bridge.config.json`. The bot checks the proxy model list again before applying a model. Image downloads are limited to 20 MB and stored under `.runtime/attachments`.

## Private Topics

Enable Topics for the bot's private chat in `@BotFather` if you want one Telegram topic per Codex session. The Bridge still works without Topics, but `/new` then switches the single private chat to the new session; earlier sessions remain available through `/history`.

## Optional automatic start

After pairing the bot, install a per-user Windows logon task:

```powershell
.\scripts\install-autostart.ps1
```

Remove it with:

```powershell
.\scripts\remove-autostart.ps1
```

The task runs after this Windows account signs in. Keep the computer awake while plugged in if you need the bot to be continuously reachable; sleep suspends both Telegram polling and local Codex access.

## Data and security

- `.runtime` is excluded from Git. The bot token is encrypted with Windows DPAPI for the current account.
- Pairing state, Telegram update offset, topic-to-thread mappings, and downloaded images are stored locally in `.runtime`.
- The Codex child process does not inherit `TELEGRAM_BOT_TOKEN`.
- New threads start with project-write access and `on-request` approvals. Fully unrestricted access requires a second confirmation in Telegram.
- The app-server protocol is experimental and may change with Codex CLI updates. Rebuild the Bridge after CLI updates.
- If Telegram reports that a webhook is configured, this bot token is already used by a webhook-based service. Remove that webhook or create a fresh bot token before starting this long-polling Bridge.
