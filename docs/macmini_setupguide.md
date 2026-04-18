# Mac mini Setup Guide

Deployment checklist for running NanoClaw on an office Mac mini, reachable from a laptop (and optionally an iPhone via the NanoVoice app) over Tailscale.

This guide covers **generic hosting** — the things every NanoClaw deployment needs. Channel- and app-specific setup lives in the corresponding skill:

- **Telegram control channel:** `/add-telegram`
- **NanoVoice iOS app + HTTP API:** `/add-nanovoice`
- **Email / calendar providers:** `/add-email-account`, `/add-gmail`, etc.

Run this guide first, then layer the skills you want.

---

## 0. Prerequisites

- Mac mini with macOS on the latest release (System Settings → General → Software Update → enable automatic security updates).
- Wired Ethernet preferred. If Wi-Fi only, ask OIT for a DHCP reservation so the address doesn't rotate.
- An Apple ID and a Tailscale account (free personal tier is fine).

## 1. Account & disk

- [ ] Create a standard (non-admin) macOS user to *run* NanoClaw if feasible. Agents should not run as an admin account.
- [ ] Enable **FileVault**: System Settings → Privacy & Security → FileVault. Store the recovery key somewhere you control (not iCloud if the data has any sensitivity).
- [ ] Enable the **Application Firewall**: System Settings → Network → Firewall. Leave "Block all incoming connections" off, but enable stealth mode.

## 2. NanoClaw install

- [ ] Clone this repo onto the Mac mini.
- [ ] Install Node (the version pinned in `.nvmrc`) and Docker Desktop.
- [ ] `npm install`
- [ ] `./container/build.sh` to build the agent container.
- [ ] Populate `.env` (see `.env.example`). Core entries:
  - Runtime/provider creds per `CLAUDE.md` (Anthropic/OpenAI keys, Telegram token if using `/add-telegram`, etc.).
  - Channel- and skill-specific entries are documented inside the corresponding skill.
- [ ] Lock down secrets:
  ```
  chmod 600 .env
  chmod 600 ~/.claude/.credentials.json 2>/dev/null
  chmod 600 ~/.codex/auth.json 2>/dev/null
  chmod -R go-rwx ~/.nanoclaw/providers 2>/dev/null
  ```
- [ ] Set `LOG_LEVEL=info` in the environment. `debug`/`trace` persists full prompts to disk (see `src/container-runner.ts`), which is fine for development but not for steady-state.

## 3. Tailscale (core networking layer)

Tailscale gives the Mac mini a stable hostname reachable from your own devices, anywhere, with automatic TLS. You want this even if you only plan to use Telegram today — future skills (NanoVoice, web dashboards) assume it.

- [ ] Install Tailscale (`brew install --cask tailscale` or App Store) and log in on the Mac mini.
- [ ] In the [Tailscale admin console](https://login.tailscale.com/admin):
  - [ ] Enable **MagicDNS**.
  - [ ] Enable **HTTPS Certificates** for the tailnet.
  - [ ] Open the Mac mini's entry → **Disable key expiry**. Otherwise the node silently drops off the tailnet every ~180 days.
- [ ] Install Tailscale on every device that needs to reach the Mac mini (laptop, iPhone) and log in with the same identity.
- [ ] (Optional) Add an ACL so only your devices can reach `tag:nanoclaw`. For a solo tailnet this is marginal, but worth it if you later invite collaborators.

Skills that need to expose NanoClaw over HTTPS (e.g. `/add-nanovoice`) will run `tailscale serve` in their own setup flow; nothing to do here beyond the above.

## 4. launchd (auto-start on reboot)

- [ ] Install the provided plist:
  ```
  cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
  ```
- [ ] Confirm it's running after a reboot. Useful commands:
  ```
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart
  launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist   # stop
  ```
- [ ] Check the log path in the plist points to somewhere you can read.

## 5. Caddy (only if you serve unrelated public web pages on this Mac mini)

Skip this section if the Mac mini isn't also hosting public web content. Skills like `/add-nanovoice` use Tailscale Serve and do **not** need Caddy.

- [ ] `brew install caddy`
- [ ] Create a Caddyfile that binds explicitly to the campus IP and **does not** add a catch-all vhost:
  ```
  {
    default_bind <CAMPUS-IP>
  }

  your-public-hostname.example {
    root * /path/to/site
    file_server
  }
  ```
  Binding explicitly to the campus IP guarantees Caddy can never serve traffic on the tailnet interface or loopback, so a misconfigured vhost cannot accidentally proxy to NanoClaw.
- [ ] `sudo brew services start caddy` (or run it under launchd if you prefer).

## 6. Control channel

Pick a primary control channel for the agent. This is where you'll issue privileged commands (`/remote-control`, `/auth`, `/model`, `/chatid`).

- [ ] Run `/add-telegram` (recommended) or another channel skill and follow its setup.
- [ ] Register your main group with `--is-main` so that group is the one the agent treats as its primary identity.

Non-interactive surfaces like `/add-nanovoice` intentionally cannot invoke privileged commands — keep one real interactive channel set up.

## 7. Optional feature skills

Layer on whatever you want. Each runs its own setup flow:

- [ ] `/add-nanovoice` — iOS voice app + `http-api` channel.
- [ ] `/add-email-account`, `/add-gmail`, `/add-ms365` — email/calendar/task providers.
- [ ] `/add-voice-transcription` — Whisper transcription for Telegram voice notes.
- [ ] `/add-reactions`, `/add-image-vision`, `/add-pdf-reader` — incremental capability upgrades.
- [ ] See `.claude/skills/` for the full catalog.

## 8. Backups

- [ ] Back up these paths to an encrypted destination (Time Machine to an encrypted disk is fine):
  - The repo itself
  - `store/messages.db`
  - `~/.nanoclaw/providers/`
  - `~/.claude/`, `~/.codex/`, `~/.config/nanoclaw/`
  - `.env`
- [ ] Verify a restore at least once. Losing the providers dir means re-authenticating every provider.

## 9. Verification pass (core)

After the core install, verify the surface is actually closed:

- [ ] `launchctl list | grep nanoclaw` shows the service running.
- [ ] `docker ps` shows no leftover `nanoclaw-*` containers after a minute of idle time.
- [ ] From a laptop **not** on the tailnet: the Mac mini exposes no NanoClaw-related ports on its campus IP (other than whatever Caddy is serving, if configured).
- [ ] From a laptop **on** the tailnet: you can reach `https://<macmini>.<tailnet>.ts.net` if (and only if) you've set up a skill that does so.

Skill-specific verification steps (curl tests against the HTTP API, voice round-trip, etc.) live in the skill's own SKILL.md.

## 10. Operational reminders

- [ ] Calendar reminder to **check the Tailscale admin console** quarterly for unexpected nodes.
- [ ] Keep an eye on `logs/` and the per-group container logs — they're the trail for anything odd.
- [ ] Rotate credentials (API keys, bot tokens, provider OAuth) whenever a device holding them is lost or replaced. Each skill documents its rotation procedure in its own SKILL.md.
