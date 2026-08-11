import { lstatSync, readFileSync } from "node:fs";
import process from "node:process";

import type { Clock, Instant } from "../domain/value-objects.js";
import { AgentId, SystemClock } from "../domain/value-objects.js";
import {
  exportLocalPublicIdentity,
  importOrganizationTrustFile,
  listLocalPeerTrust,
  localE2eeFingerprint,
  localE2eeStatus,
  replenishLocalPrekeys,
  revokeLocalAgentKey,
  rotateLocalAgentKey,
  trustPeerFingerprint,
} from "./local-commands.js";
import { LocalE2eeVault } from "./local-vault.js";
import type { StoredAgentKey } from "./local-vault-rows.js";
import type { ActiveTenantBinding } from "./local-vault-settings.js";
import { type OrganizationTrustPolicy, parseSerializedTrustPolicy } from "./trust-policy.js";
import { defaultE2eeVaultPath } from "./vault-paths.js";

const MAX_TRUST_FILE_BYTES: number = 1024 * 1024;

const HELP: string = `Murmur local end-to-end encryption

Usage:
  murmur e2ee status
  murmur e2ee fingerprint
  murmur e2ee peers
  murmur e2ee trust --agent ID --fingerprint FULL
  murmur e2ee trust-file --path FILE [--issuer-fingerprint FULL]
  murmur e2ee rotate-agent-key [--agent ID]
  murmur e2ee revoke-agent-key [--agent ID] --reason REASON
  murmur e2ee replenish [--agent ID]
  murmur e2ee export-public

The active tenant is bound locally from the last validated hosted capability.
Private keys are never exportable. First-time organization trust import requires
an independently verified full issuer fingerprint.
`;

export type E2eeCliRuntime = {
  readonly clock: Clock;
  readonly createVault: (path: string) => LocalE2eeVault;
  readonly defaultVaultPath: () => string;
  readonly readTrustFile: (path: string) => string;
};

const DEFAULT_RUNTIME: E2eeCliRuntime = {
  clock: new SystemClock(),
  createVault: (path: string): LocalE2eeVault => new LocalE2eeVault(path),
  defaultVaultPath: (): string => defaultE2eeVaultPath(process.env),
  readTrustFile: (path: string): string => {
    const metadata: ReturnType<typeof lstatSync> = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The organization trust path must be a regular file, not a symbolic link");
    }
    if (metadata.size > MAX_TRUST_FILE_BYTES) {
      throw new Error("The organization trust file exceeds its size limit");
    }
    return readFileSync(path, "utf8");
  },
};

type ParsedArguments = {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
  readonly vaultPath: string;
};

function parseArguments(arguments_: readonly string[], runtime: E2eeCliRuntime): ParsedArguments {
  const command: string | undefined = arguments_[0];
  if (command === undefined || command === "--help" || command === "-h") {
    return {
      command: "help",
      options: new Map<string, string>(),
      vaultPath: runtime.defaultVaultPath(),
    };
  }
  const options: Map<string, string> = new Map<string, string>();
  let vaultPath: string = runtime.defaultVaultPath();
  for (let index: number = 1; index < arguments_.length; index += 1) {
    const option: string | undefined = arguments_[index];
    if (option === undefined || !option.startsWith("--")) {
      throw new Error(`Unexpected E2E command argument: ${option ?? ""}`);
    }
    const value: string | undefined = arguments_[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${option} requires a value`);
    if (options.has(option)) throw new Error(`Duplicate E2E command option: ${option}`);
    if (option === "--vault-path") vaultPath = value;
    else options.set(option, value);
    index += 1;
  }
  return { command, options, vaultPath };
}

function exactOptions(options: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const option of options.keys()) {
    if (!allowed.includes(option)) throw new Error(`Unknown E2E command option: ${option}`);
  }
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value: string | undefined = options.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function activeTenant(vault: LocalE2eeVault): ActiveTenantBinding {
  const active: ActiveTenantBinding | null = vault.settings.getActiveTenant();
  if (active === null) {
    throw new Error(
      "No active E2E tenant is bound; start the encrypted Murmur proxy with the intended credential first",
    );
  }
  return active;
}

function selectedAgent(vault: LocalE2eeVault, configured: string | undefined): string {
  if (configured !== undefined) return AgentId.parse(configured).value;
  const agents: readonly StoredAgentKey[] = vault.keys.listAgents();
  if (agents.length === 0) {
    throw new Error("No local E2E agent key exists; register an encrypted agent first");
  }
  if (agents.length !== 1) {
    throw new Error("More than one local E2E agent exists; select one with --agent");
  }
  const agent: StoredAgentKey | undefined = agents[0];
  if (agent === undefined) throw new Error("No local E2E agent key exists");
  return agent.certificate.agentId;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function execute(
  parsed: ParsedArguments,
  vault: LocalE2eeVault,
  runtime: E2eeCliRuntime,
): Promise<string> {
  const now: Instant = runtime.clock.now();
  switch (parsed.command) {
    case "status": {
      exactOptions(parsed.options, []);
      const active: ActiveTenantBinding | null = vault.settings.getActiveTenant();
      return json({
        ...localE2eeStatus(vault),
        active_tenant_bound_at: active === null ? null : active.boundAt,
        active_tenant_id: active === null ? null : active.tenantId,
      });
    }
    case "fingerprint":
      exactOptions(parsed.options, []);
      return `${localE2eeFingerprint(vault)}\n`;
    case "peers":
      exactOptions(parsed.options, []);
      return json({ peers: listLocalPeerTrust(vault) });
    case "trust": {
      exactOptions(parsed.options, ["--agent", "--fingerprint"]);
      const active: ActiveTenantBinding = activeTenant(vault);
      return json(
        trustPeerFingerprint(
          vault,
          {
            agentId: AgentId.parse(requiredOption(parsed.options, "--agent")).value,
            rootKeyId: requiredOption(parsed.options, "--fingerprint"),
            tenantId: active.tenantId,
          },
          now,
        ),
      );
    }
    case "trust-file": {
      exactOptions(parsed.options, ["--issuer-fingerprint", "--path"]);
      const active: ActiveTenantBinding = activeTenant(vault);
      const serialized: string = runtime.readTrustFile(requiredOption(parsed.options, "--path"));
      const policy: OrganizationTrustPolicy = parseSerializedTrustPolicy(serialized);
      if (policy.tenantId !== active.tenantId) {
        throw new Error("The organization trust file does not match the active tenant");
      }
      const current: ReturnType<typeof vault.trust.getPolicyState> = vault.trust.getPolicyState(
        active.tenantId,
      );
      const configuredIssuer: string | undefined = parsed.options.get("--issuer-fingerprint");
      const expectedIssuer: string | null =
        configuredIssuer === undefined
          ? current === null
            ? null
            : current.issuerKeyId
          : configuredIssuer;
      if (expectedIssuer === null) {
        throw new Error("--issuer-fingerprint is required for the first organization trust import");
      }
      return json(await importOrganizationTrustFile(vault, serialized, expectedIssuer, now));
    }
    case "rotate-agent-key": {
      exactOptions(parsed.options, ["--agent"]);
      const agentId: string = selectedAgent(vault, parsed.options.get("--agent"));
      return json(await rotateLocalAgentKey(vault, agentId, now));
    }
    case "revoke-agent-key": {
      exactOptions(parsed.options, ["--agent", "--reason"]);
      const agentId: string = selectedAgent(vault, parsed.options.get("--agent"));
      return json(
        await revokeLocalAgentKey(vault, agentId, requiredOption(parsed.options, "--reason"), now),
      );
    }
    case "replenish": {
      exactOptions(parsed.options, ["--agent"]);
      const agentId: string = selectedAgent(vault, parsed.options.get("--agent"));
      return json(await replenishLocalPrekeys(vault, agentId, now));
    }
    case "export-public":
      exactOptions(parsed.options, []);
      return json(exportLocalPublicIdentity(vault));
    default:
      throw new Error(`Unknown E2E command: ${parsed.command}\n\n${HELP}`);
  }
}

export async function runE2eeCli(
  arguments_: readonly string[],
  runtime: E2eeCliRuntime = DEFAULT_RUNTIME,
): Promise<string> {
  const parsed: ParsedArguments = parseArguments(arguments_, runtime);
  if (parsed.command === "help") return HELP;
  const vault: LocalE2eeVault = runtime.createVault(parsed.vaultPath);
  try {
    return await execute(parsed, vault, runtime);
  } finally {
    vault.close();
  }
}
