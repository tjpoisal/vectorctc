/**
 * v0.5: which agent (and, when known, which model) is behind gate decisions. The MCP server records the
 * client's `clientInfo` from the initialize handshake; CLI and hook surfaces can set CTC_AGENT. MCP does not
 * report the model, so the model comes only from CTC_MODEL.
 */

export interface GateClient {
  name: string;
  version: string | null;
}

let current: GateClient | null = null;

export function setGateClient(client: { name?: string; version?: string } | null | undefined): void {
  current = client && client.name ? { name: String(client.name).slice(0, 100), version: client.version ? String(client.version).slice(0, 50) : null } : null;
}

export function gateClient(env: NodeJS.ProcessEnv = process.env): GateClient | null {
  if (current) return current;
  const name = env.CTC_AGENT?.trim();
  return name ? { name: name.slice(0, 100), version: null } : null;
}

export function gateModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const model = env.CTC_MODEL?.trim();
  return model ? model.slice(0, 100) : null;
}

/** The label a decision is grouped under in the report card. */
export function agentLabel(record: { client?: { name: string; version: string | null } | undefined; actor?: string | null; surface: string }): string {
  if (record.client?.name) return record.client.name;
  if (record.actor) return record.actor;
  return `unknown (${record.surface})`;
}
