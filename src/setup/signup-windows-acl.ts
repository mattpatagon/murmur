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
$path = $env:MURMUR_SIGNUP_ACL_PATH
$isDirectory = $env:MURMUR_SIGNUP_ACL_DIRECTORY -eq '1'
$protect = $env:MURMUR_SIGNUP_ACL_OPERATION -eq 'protect'
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
if ($item.PSIsContainer -ne $isDirectory) { throw 'path type' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
}
if ($protect) {
  if ($isDirectory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$actual = Get-Acl -LiteralPath $path
if (-not $actual.AreAccessRulesProtected) { throw 'inheritance' }
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'rule count' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited) { throw 'principal' }
if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'access type' }
if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'rights' }
if ($rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'propagation' }
Write-Output '{"owner_only":true}'
`;

const AclResultSchema: z.ZodType<{ readonly owner_only: true }> = z.strictObject({
  owner_only: z.literal(true),
});

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
    throw new Error("Windows could not establish owner-only signup credential permissions");
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
