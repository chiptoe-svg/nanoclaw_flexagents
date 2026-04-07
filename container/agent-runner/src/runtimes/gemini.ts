/**
 * Google Gemini CLI runtime for the container agent-runner.
 * Self-registers with the container runtime registry.
 *
 * Uses Gemini CLI in non-interactive mode with --yolo (auto-approve).
 * Captures output for archiving and follow-up processing.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import {
  ContainerInput,
  drainIpcInput,
  formatTranscriptMarkdown,
  log,
  ParsedMessage,
  sanitizeFilename,
  shouldClose,
  writeOutput,
} from '../shared.js';
import { registerContainerRuntime, type QueryResult } from '../runtime-registry.js';

const MAX_OUTPUT = 200 * 1024;

// --- Gemini query ---

async function runGeminiQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<QueryResult> {
  // Assemble GEMINI.md from global + group AGENT.md files
  const agentsParts: string[] = [];
  for (const dir of ['/workspace/global', '/workspace/group']) {
    for (const filename of ['AGENT.md', 'GEMINI.md', 'CLAUDE.md']) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        agentsParts.push(fs.readFileSync(filePath, 'utf-8'));
        break;
      }
    }
  }
  if (agentsParts.length > 0) {
    fs.writeFileSync(
      '/workspace/group/GEMINI.md',
      agentsParts.join('\n\n---\n\n'),
    );
    log(`Assembled GEMINI.md from ${agentsParts.length} source(s)`);
  }

  // Write MCP server config for Gemini CLI
  const geminiConfigDir = path.join(process.env.HOME || '/home/node', '.gemini');
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  const settingsPath = path.join(geminiConfigDir, 'settings.json');

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }
  if (!settings.mcpServers || !(settings.mcpServers as Record<string, unknown>).nanoclaw) {
    settings.mcpServers = {
      ...(settings.mcpServers as Record<string, unknown> || {}),
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log('Wrote NanoClaw MCP config to Gemini settings.json');
  }

  // Discover additional directories
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const model = containerInput.model || 'gemini-2.5-flash';
  let closedDuringQuery = false;

  let ipcPolling = true;
  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpc, 500);
  };
  setTimeout(pollIpc, 500);

  try {
    const resultText = await runGeminiCli(prompt, model, extraDirs);

    // Archive conversation with whatever detail we have
    if (resultText) {
      try {
        const archiveMessages: ParsedMessage[] = [
          { role: 'user', content: prompt },
          { role: 'assistant', content: resultText },
        ];
        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const name = sanitizeFilename(prompt.slice(0, 50).replace(/\n/g, ' '));
        const filePath = path.join(conversationsDir, `${date}-${name || 'conversation'}.md`);
        fs.writeFileSync(
          filePath,
          formatTranscriptMarkdown(archiveMessages, prompt.slice(0, 50), containerInput.assistantName),
        );
        log(`Archived Gemini conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    writeOutput({ status: 'success', result: resultText, newSessionId: undefined });

    // Post-turn follow-ups: process IPC messages that arrived during the turn
    ipcPolling = false;
    const pendingMessages = drainIpcInput();
    if (pendingMessages.length > 0 && !closedDuringQuery) {
      log(`Processing ${pendingMessages.length} IPC message(s) that arrived during turn`);
      const followUp = pendingMessages.join('\n');
      try {
        const followUpResult = await runGeminiCli(followUp, model, extraDirs);
        if (followUpResult) {
          writeOutput({ status: 'success', result: followUpResult, newSessionId: undefined });
        }
      } catch (err) {
        log(`Follow-up error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Gemini error: ${error}`);
    writeOutput({ status: 'error', result: null, error });
  }

  ipcPolling = false;
  return { newSessionId: undefined, closedDuringQuery };
}

// --- Gemini CLI execution ---

function runGeminiCli(
  prompt: string,
  model: string,
  extraDirs: string[],
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--yolo', '--model', model];

    // Pass additional directories if supported
    // Note: Gemini CLI may not support --additional-directories flag;
    // the directories are mounted and accessible via filesystem tools

    log(`Running: gemini -p "${prompt.slice(0, 60)}..." --model ${model}`);

    execFile(
      'gemini',
      args,
      {
        cwd: '/workspace/group',
        timeout: 120_000,
        maxBuffer: MAX_OUTPUT,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          for (const line of stderr.trim().split('\n')) {
            if (line) log(`[gemini] ${line}`);
          }
        }
        if (error && !stdout) {
          reject(new Error(error.message));
          return;
        }
        resolve(stdout.trim() || null);
      },
    );
  });
}

// --- Self-register ---

registerContainerRuntime('gemini', runGeminiQuery);
