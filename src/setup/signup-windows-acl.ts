import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import process from "node:process";
import { z } from "zod";

export type SignupAclRequest = {
  readonly directory: boolean;
  readonly operation: "protect" | "verify";
  readonly path: string;
};

export type SignupAclExecutor = (
  command: string,
  arguments_: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export const SIGNUP_ACL_TIMEOUT_MS: number = 5000;

// A fresh descriptor removes explicit grants as well as inherited grants. icacls /grant:r
// only replaces this user's ACE and cannot establish an owner-only boundary by itself.
export const SIGNUP_ACL_SCRIPT: string = `
$ErrorActionPreference = 'Stop'
$stage = 'inspect_path'
try {
$path = $env:MURMUR_SIGNUP_ACL_PATH
$isDirectory = $env:MURMUR_SIGNUP_ACL_DIRECTORY -eq '1'
$protect = $env:MURMUR_SIGNUP_ACL_OPERATION -eq 'protect'
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
if ($item.PSIsContainer -ne $isDirectory) { throw 'path type' }
$stage = 'resolve_identity'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
}
if ($protect) {
  $stage = 'create_descriptor'
  if ($isDirectory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object Security.AccessControl.FileSecurity }
  $stage = 'set_owner'
  $acl.SetOwner($sid)
  $stage = 'protect_inheritance'
  $acl.SetAccessRuleProtection($true, $false)
  $stage = 'create_rule'
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $stage = 'add_rule'
  $acl.AddAccessRule($rule)
  $stage = 'apply_acl'
  # Set-Acl copies all descriptor sections, including unset group/audit fields. Persist
  # only the owner and access sections changed above, retaining unrelated security fields.
  $item.SetAccessControl($acl)
}
$stage = 'read_acl'
$actual = Get-Acl -LiteralPath $path
$stage = 'verify_inheritance'
if (-not $actual.AreAccessRulesProtected) { throw 'inheritance' }
$stage = 'verify_owner'
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
$stage = 'verify_rule_count'
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'rule count' }
$rule = $rules[0]
$stage = 'verify_principal'
if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited) { throw 'principal' }
$stage = 'verify_access_type'
if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'access type' }
$stage = 'verify_rights'
if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'rights' }
$stage = 'verify_propagation'
if ($rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'propagation' }
[Console]::Out.WriteLine('{"owner_only":true}')
} catch {
  [Console]::Out.WriteLine('{"owner_only":false,"stage":"' + $stage + '"}')
  exit 1
}
`;

const AclResultSchema: z.ZodType<{ readonly owner_only: true }> = z.strictObject({
  owner_only: z.literal(true),
});

const AclFailureStageSchema: z.ZodEnum<{
  inspect_path: "inspect_path";
  resolve_identity: "resolve_identity";
  create_descriptor: "create_descriptor";
  set_owner: "set_owner";
  protect_inheritance: "protect_inheritance";
  create_rule: "create_rule";
  add_rule: "add_rule";
  apply_acl: "apply_acl";
  read_acl: "read_acl";
  verify_inheritance: "verify_inheritance";
  verify_owner: "verify_owner";
  verify_rule_count: "verify_rule_count";
  verify_principal: "verify_principal";
  verify_access_type: "verify_access_type";
  verify_rights: "verify_rights";
  verify_propagation: "verify_propagation";
}> = z.enum([
  "inspect_path",
  "resolve_identity",
  "create_descriptor",
  "set_owner",
  "protect_inheritance",
  "create_rule",
  "add_rule",
  "apply_acl",
  "read_acl",
  "verify_inheritance",
  "verify_owner",
  "verify_rule_count",
  "verify_principal",
  "verify_access_type",
  "verify_rights",
  "verify_propagation",
]);
const AclFailureSchema: z.ZodType<{
  readonly owner_only: false;
  readonly stage: z.infer<typeof AclFailureStageSchema>;
}> = z.strictObject({ owner_only: z.literal(false), stage: AclFailureStageSchema });

function failedAclStage(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (_error: unknown) {
    return null;
  }
  const validated: z.ZodSafeParseResult<z.infer<typeof AclFailureSchema>> =
    AclFailureSchema.safeParse(parsed);
  return validated.success ? validated.data.stage : null;
}

export function runSignupWindowsAcl(
  request: SignupAclRequest,
  execute: SignupAclExecutor = spawnSync,
): void {
  const result: SpawnSyncReturns<string> = execute(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SIGNUP_ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MURMUR_SIGNUP_ACL_DIRECTORY: request.directory ? "1" : "0",
        MURMUR_SIGNUP_ACL_OPERATION: request.operation,
        MURMUR_SIGNUP_ACL_PATH: request.path,
      },
      maxBuffer: 4096,
      timeout: SIGNUP_ACL_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const stage: string | null = failedAclStage(result.stdout);
    throw new Error(
      `Windows could not establish owner-only signup credential permissions${stage === null ? "" : ` (stage: ${stage})`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_error: unknown) {
    throw new Error("Windows signup permission verification returned invalid output");
  }
  if (!AclResultSchema.safeParse(parsed).success) {
    throw new Error("Windows signup permission verification did not prove owner-only access");
  }
}
