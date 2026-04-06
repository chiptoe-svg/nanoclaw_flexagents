# CU Agent

Multi-runtime personal assistant built on NanoClaw. Supports OpenAI (Codex) and Claude runtimes.

## Architecture

Four-layer system:
1. **App Shell** — channels, state, scheduling, IPC (`src/index.ts`)
2. **AgentRuntime** — runtime adapters that delegate to containers (`src/runtime/`)
3. **Tool Layer** — SDK-native tools inside containers + ToolExecutor for future local models
4. **Model Layer** — per-group model selection via container config

Both runtimes run inside the same container image. The agent-runner detects the runtime from `ContainerInput.runtime` and uses the appropriate SDK.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, runtime invocation |
| `src/runtime/types.ts` | AgentRuntime, ContainerManager, ToolExecutor interfaces |
| `src/runtime/claude-runtime.ts` | Claude adapter (delegates to container) |
| `src/runtime/openai-runtime.ts` | OpenAI/Codex adapter (delegates to container) |
| `src/runtime/container-manager.ts` | Container lifecycle management |
| `src/runtime/tool-executor.ts` | Host-side tool layer (IPC tools, skill discovery) |
| `src/runtime/tool-broker.ts` | WebSocket server for tool-runner containers (future local models) |
| `src/container-runner.ts` | Container spawning, mounts, credential injection |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/config.ts` | Config: runtime, model, trigger, paths, intervals |
| `src/credential-proxy.ts` | Anthropic credential proxy (Claude runtime) |
| `src/auth-switch.ts` | Toggle between API key and OAuth modes |
| `src/task-scheduler.ts` | Runs scheduled tasks via AgentRuntime |
| `container/agent-runner/src/index.ts` | In-container agent loop (both Claude and Codex) |
| `container/agent-runner/src/shared.ts` | Shared container plumbing (IO, IPC, MessageStream) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server for NanoClaw IPC tools |
| `container/tool-runner/` | Lightweight container for sandboxed tool execution |
| `container/skills/` | Skills loaded inside agent containers |
| `groups/{name}/AGENT.md` | Per-group agent persona (runtime-agnostic) |
| `groups/global/AGENT.md` | Global persona shared across all groups |
| `groups/{name}/memory/` | Persistent memory (user profile, knowledge) |

## Runtime Configuration

Default runtime and model set in `.env`:
```
DEFAULT_RUNTIME=openai
OPENAI_MODEL=gpt-5.4-mini
```

Per-group override via `containerConfig` in the database:
```sql
UPDATE registered_groups SET container_config = '{"runtime":"claude","model":"claude-sonnet-4-6"}' WHERE jid = '...';
```

Telegram commands:
- `/model` — view/switch model for this group
- `/auth` — view/switch auth mode
- `/ping` — bot status
- `/chatid` — get chat registration ID

## Credentials

**OpenAI (Codex):** Subscription auth via `codex auth login` on the host. Credentials in `~/.codex/auth.json` are synced to containers. Falls back to `OPENAI_API_KEY` in `.env`.

**Claude:** OAuth token via `claude setup-token` stored in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. Auto-refreshes from `~/.claude/.credentials.json` if available. Credential proxy on port 3001 injects into Claude containers.

## Agent Persona (AGENT.md)

`AGENT.md` is the canonical persona file. It's runtime-agnostic.

Inside the container, the agent-runner assembles the final instructions:
- **Codex:** concatenates `global/AGENT.md` + `group/AGENT.md` → writes `AGENTS.md`
- **Claude:** copies `AGENT.md` → `CLAUDE.md` for SDK discovery, injects global via system prompt

Fallback: `CLAUDE.md` is read if `AGENT.md` doesn't exist (backward compatible).

## Skills

Container skills in `container/skills/` are synced to both `.claude/skills/` and `.codex/skills/` per group. Same SKILL.md format works with both SDKs.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (macOS):
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
