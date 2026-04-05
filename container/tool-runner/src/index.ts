/**
 * NanoClaw Tool Runner
 *
 * Runs inside a container. Connects to the host's tool broker via WebSocket.
 * Receives tool call requests, executes them, returns results.
 *
 * Environment:
 *   TOOL_BROKER_URL  — ws://host.docker.internal:3002 (set by ContainerManager)
 *   GROUP_FOLDER     — group identifier for broker registration
 *
 * Tools implemented: bash, read, write, edit, glob, grep
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// --- Protocol types (must match tool-broker.ts) ---

interface ToolCallMessage {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResultMessage {
  id: string;
  content: string;
  isError: boolean;
}

// --- Config ---

const BROKER_URL = process.env.TOOL_BROKER_URL || 'ws://host.docker.internal:3002';
const GROUP_FOLDER = process.env.GROUP_FOLDER || 'unknown';
const WORKSPACE = '/workspace/group';
const MAX_OUTPUT = 100 * 1024; // 100KB output limit per tool call

function log(msg: string): void {
  console.error(`[tool-runner] ${msg}`);
}

// --- Tool implementations ---

async function executeBash(args: {
  command: string;
  timeout?: number;
}): Promise<ToolResultMessage & { id: '' }> {
  const timeout = args.timeout || 120_000;
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', args.command],
      {
        cwd: WORKSPACE,
        timeout,
        maxBuffer: MAX_OUTPUT,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
        if (error && !stdout && !stderr) {
          resolve({
            id: '',
            content: `Error: ${error.message}`,
            isError: true,
          });
        } else {
          resolve({ id: '', content: output || '(no output)', isError: !!error });
        }
      },
    );
  });
}

function executeRead(args: {
  file_path: string;
  offset?: number;
  limit?: number;
}): ToolResultMessage & { id: '' } {
  try {
    const filePath = path.resolve(WORKSPACE, args.file_path);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = args.offset || 0;
    const limit = args.limit || 2000;
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice
      .map((line, i) => `${offset + i + 1}\t${line}`)
      .join('\n');
    return { id: '', content: numbered, isError: false };
  } catch (err) {
    return {
      id: '',
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeWrite(args: {
  file_path: string;
  content: string;
}): ToolResultMessage & { id: '' } {
  try {
    const filePath = path.resolve(WORKSPACE, args.file_path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content);
    return { id: '', content: `Written: ${filePath}`, isError: false };
  } catch (err) {
    return {
      id: '',
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeEdit(args: {
  file_path: string;
  old_string: string;
  new_string: string;
}): ToolResultMessage & { id: '' } {
  try {
    const filePath = path.resolve(WORKSPACE, args.file_path);
    const content = fs.readFileSync(filePath, 'utf-8');
    const occurrences = content.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return { id: '', content: 'Error: old_string not found in file', isError: true };
    }
    if (occurrences > 1) {
      return {
        id: '',
        content: `Error: old_string found ${occurrences} times (must be unique)`,
        isError: true,
      };
    }
    const updated = content.replace(args.old_string, args.new_string);
    fs.writeFileSync(filePath, updated);
    return { id: '', content: `Edited: ${filePath}`, isError: false };
  } catch (err) {
    return {
      id: '',
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeGlob(args: {
  pattern: string;
  path?: string;
}): ToolResultMessage & { id: '' } {
  try {
    const searchDir = args.path
      ? path.resolve(WORKSPACE, args.path)
      : WORKSPACE;
    const results: string[] = [];
    const picomatch = require('picomatch') as typeof import('picomatch');
    const isMatch = picomatch(args.pattern);

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(searchDir, full);
        if (entry.isDirectory()) {
          walk(full);
        } else if (isMatch(rel) || isMatch(entry.name)) {
          results.push(rel);
        }
      }
    }

    walk(searchDir);
    return {
      id: '',
      content: results.length > 0 ? results.join('\n') : 'No matches found',
      isError: false,
    };
  } catch (err) {
    return {
      id: '',
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function executeGrep(args: {
  pattern: string;
  path?: string;
  include?: string;
}): Promise<ToolResultMessage & { id: '' }> {
  const searchPath = args.path
    ? path.resolve(WORKSPACE, args.path)
    : WORKSPACE;
  const grepArgs = ['-rn'];
  if (args.include) grepArgs.push(`--include=${args.include}`);
  grepArgs.push(args.pattern, searchPath);

  return new Promise((resolve) => {
    execFile(
      'grep',
      grepArgs,
      { maxBuffer: MAX_OUTPUT, timeout: 30_000 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve({ id: '', content: 'No matches found', isError: false });
        } else {
          resolve({
            id: '',
            content: stdout.slice(0, MAX_OUTPUT) || 'No matches found',
            isError: false,
          });
        }
      },
    );
  });
}

// --- Tool dispatch ---

async function executeTool(
  call: ToolCallMessage,
): Promise<ToolResultMessage> {
  const args = call.args as Record<string, unknown>;
  let result: ToolResultMessage & { id: '' };

  switch (call.tool) {
    case 'bash':
      result = await executeBash(args as { command: string; timeout?: number });
      break;
    case 'read':
      result = executeRead(args as { file_path: string; offset?: number; limit?: number });
      break;
    case 'write':
      result = executeWrite(args as { file_path: string; content: string });
      break;
    case 'edit':
      result = executeEdit(args as { file_path: string; old_string: string; new_string: string });
      break;
    case 'glob':
      result = executeGlob(args as { pattern: string; path?: string });
      break;
    case 'grep':
      result = await executeGrep(args as { pattern: string; path?: string; include?: string });
      break;
    default:
      result = { id: '', content: `Unknown tool: ${call.tool}`, isError: true };
  }

  return { ...result, id: call.id };
}

// --- WebSocket client ---

function connect(): void {
  const url = `${BROKER_URL}?group=${encodeURIComponent(GROUP_FOLDER)}`;
  log(`Connecting to tool broker: ${url}`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    log('Connected to tool broker');
  });

  ws.on('message', async (data) => {
    try {
      const call: ToolCallMessage = JSON.parse(data.toString());
      log(`Tool call: ${call.tool} (id=${call.id})`);
      const startTime = Date.now();
      const result = await executeTool(call);
      const duration = Date.now() - startTime;
      log(`Tool result: ${call.tool} (id=${call.id}) ${result.isError ? 'ERROR' : 'OK'} ${duration}ms`);
      ws.send(JSON.stringify(result));
    } catch (err) {
      log(`Error processing tool call: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on('close', (code) => {
    log(`Disconnected from broker (code=${code})`);
    if (code !== 1000) {
      // Reconnect on unexpected close
      log('Reconnecting in 2s...');
      setTimeout(connect, 2000);
    } else {
      // Clean close — broker told us to stop
      process.exit(0);
    }
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

// --- Main ---

log(`Tool runner starting (group=${GROUP_FOLDER})`);
connect();
