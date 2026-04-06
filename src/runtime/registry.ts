/**
 * Agent SDK registry — mirrors src/channels/registry.ts pattern.
 *
 * Each agent SDK (Claude, Codex) self-registers by calling registerAgentSdk()
 * when its module is imported. The barrel file (index.ts) controls which
 * SDKs are loaded. Missing SDKs are silently skipped at startup.
 */
import type { AgentRuntime } from './types.js';

export type AgentSdkFactory = () => AgentRuntime;

const registry = new Map<string, AgentSdkFactory>();

export function registerAgentSdk(name: string, factory: AgentSdkFactory): void {
  registry.set(name, factory);
}

export function getAgentSdkFactory(name: string): AgentSdkFactory | undefined {
  return registry.get(name);
}

export function getRegisteredAgentSdkNames(): string[] {
  return [...registry.keys()];
}
