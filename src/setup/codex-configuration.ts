import { isBootstrapMurmurEndpoint } from "./bootstrap-configuration.js";
import { MURMUR_TOKEN_ENV } from "./client-configuration.js";

type JsonRecord = Record<string, unknown>;

type TomlSection = {
  readonly end: number;
  readonly headerEnd: number;
  readonly name: string;
  readonly start: number;
};

type MurmurTomlSectionKind = "nested" | "root";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlSections(content: string): readonly TomlSection[] {
  const headerPattern: RegExp = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/gmu;
  const headers: Array<Omit<TomlSection, "end">> = [];
  for (const match of content.matchAll(headerPattern)) {
    const name: string | undefined = match[1];
    const start: number | undefined = match.index;
    if (name === undefined || start === undefined) continue;
    headers.push({ headerEnd: start + match[0].length, name: name.trim(), start });
  }
  return headers.map((header: Omit<TomlSection, "end">, index: number): TomlSection => {
    const nextHeader: Omit<TomlSection, "end"> | undefined = headers[index + 1];
    return {
      ...header,
      end: nextHeader === undefined ? content.length : nextHeader.start,
    };
  });
}

const TOML_SECTION_MARKER: string = "__murmur_section_marker__";

function containsTomlSectionMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value[TOML_SECTION_MARKER] === true) return true;
  return Object.values(value).some((nested: unknown): boolean => containsTomlSectionMarker(nested));
}

function murmurTomlSectionKind(name: string): MurmurTomlSectionKind | null {
  try {
    const parsed: unknown = Bun.TOML.parse(`[${name}]\n${TOML_SECTION_MARKER} = true\n`);
    if (!isRecord(parsed)) return null;
    const servers: unknown = parsed["mcp_servers"];
    if (!isRecord(servers)) return null;
    const murmur: unknown = servers["murmur"];
    if (!isRecord(murmur)) return null;
    if (murmur[TOML_SECTION_MARKER] === true) return "root";
    return containsTomlSectionMarker(murmur) ? "nested" : null;
  } catch (_error: unknown) {
    return null;
  }
}

function parseSimpleTomlString(sectionBody: string, key: string): string | null {
  const escapedKey: string = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match: RegExpMatchArray | null = sectionBody.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`, "mu"),
  );
  if (match === null || match[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return typeof parsed === "string" ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

function codexServerBlock(url: string): string {
  return [
    "[mcp_servers.murmur]",
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(MURMUR_TOKEN_ENV)}`,
    'http_headers = { "X-Murmur-Client" = "codex" }',
  ].join("\n");
}

function removeMurmurTomlSections(content: string): string {
  const matchingSections: readonly TomlSection[] = tomlSections(content).filter(
    (section: TomlSection): boolean => murmurTomlSectionKind(section.name) !== null,
  );
  let result: string = content;
  for (const section of [...matchingSections].reverse()) {
    result = `${result.slice(0, section.start)}${result.slice(section.end)}`;
  }
  return result.trimEnd();
}

function withoutInlineHeader(line: string, headerName: string): string {
  const escapedName: string = headerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const assignment: string = `"${escapedName}"\\s*=\\s*"(?:[^"\\\\]|\\\\.)*"`;
  return line
    .replace(new RegExp(`${assignment}\\s*,\\s*`, "gu"), "")
    .replace(new RegExp(`,\\s*${assignment}`, "gu"), "")
    .replace(new RegExp(assignment, "gu"), "");
}

function removeStaticCodexContextHeaders(content: string, section: TomlSection): string {
  const sectionText: string = content.slice(section.start, section.end);
  if (!/"X-Murmur-(?:Repository|Branch)"\s*=/u.test(sectionText)) return content;
  const inlineHeaders: RegExpMatchArray | null = sectionText.match(
    /^(\s*http_headers\s*=\s*\{)([^\r\n}]*)(\}\s*(?:#.*)?)$/mu,
  );
  if (inlineHeaders === null || inlineHeaders.index === undefined) {
    throw new Error(
      "Static Codex Murmur repository or branch headers are not portable at user scope. Rerun with --replace.",
    );
  }
  const values: string = withoutInlineHeader(
    withoutInlineHeader(inlineHeaders[2] ?? "", "X-Murmur-Repository"),
    "X-Murmur-Branch",
  ).trim();
  const replacement: string = `${inlineHeaders[1]}${values === "" ? " " : ` ${values} `}${inlineHeaders[3]}`;
  const start: number = section.start + inlineHeaders.index;
  return `${content.slice(0, start)}${replacement}${content.slice(start + inlineHeaders[0].length)}`;
}

function addCodexClientHeader(content: string, section: TomlSection): string {
  const sectionText: string = content.slice(section.start, section.end);
  if (/"X-Murmur-Client"\s*=\s*"codex"/u.test(sectionText)) return content;
  if (/"X-Murmur-Client"\s*=/u.test(sectionText)) {
    throw new Error(
      'The existing Codex Murmur client header is not "codex". Inspect it or rerun with --replace.',
    );
  }

  const inlineHeaders: RegExpMatchArray | null = sectionText.match(
    /^(\s*http_headers\s*=\s*\{)([^\r\n}]*)(\}\s*(?:#.*)?)$/mu,
  );
  if (inlineHeaders !== null && inlineHeaders.index !== undefined) {
    const existingValue: string | undefined = inlineHeaders[2];
    const existing: string = existingValue === undefined ? "" : existingValue.trim();
    const separator: string = existing === "" ? " " : ` ${existing}, `;
    const replacement: string = `${inlineHeaders[1]}${separator}"X-Murmur-Client" = "codex" ${inlineHeaders[3]}`;
    const start: number = section.start + inlineHeaders.index;
    return `${content.slice(0, start)}${replacement}${content.slice(start + inlineHeaders[0].length)}`;
  }

  if (/^\s*http_headers\s*=/mu.test(sectionText)) {
    throw new Error(
      'The existing Codex Murmur http_headers value is not an inline TOML table. Add X-Murmur-Client = "codex" to it, or rerun with --replace.',
    );
  }

  const insertion: string = '\nhttp_headers = { "X-Murmur-Client" = "codex" }';
  return `${content.slice(0, section.end).trimEnd()}${insertion}\n\n${content.slice(section.end).trimStart()}`;
}

export function configureCodexMcp(current: string, url: string, replace: boolean = false): string {
  const sections: readonly TomlSection[] = tomlSections(current);
  const section: TomlSection | undefined = sections.find(
    (candidate: TomlSection): boolean => murmurTomlSectionKind(candidate.name) === "root",
  );
  if (section === undefined) {
    const prefix: string = current.trimEnd();
    return `${prefix === "" ? "" : `${prefix}\n\n`}${codexServerBlock(url)}\n`;
  }

  const body: string = current.slice(section.headerEnd, section.end);
  const existingUrl: string | null = parseSimpleTomlString(body, "url");
  const tokenEnvironment: string | null = parseSimpleTomlString(body, "bearer_token_env_var");
  if (existingUrl !== url || tokenEnvironment !== MURMUR_TOKEN_ENV) {
    if (!replace && !isBootstrapMurmurEndpoint(existingUrl, url)) {
      throw new Error(
        "Codex already has a different mcp_servers.murmur configuration. Inspect it or rerun with --replace.",
      );
    }
    const withoutMurmur: string = removeMurmurTomlSections(current);
    return `${withoutMurmur === "" ? "" : `${withoutMurmur}\n\n`}${codexServerBlock(url)}\n`;
  }

  const hasNestedMurmurSections: boolean = sections.some(
    (candidate: TomlSection): boolean => murmurTomlSectionKind(candidate.name) === "nested",
  );
  if (hasNestedMurmurSections) {
    if (!replace) {
      throw new Error(
        "Codex uses nested Murmur configuration that cannot be updated safely. Inspect it or rerun with --replace.",
      );
    }
    const withoutMurmur: string = removeMurmurTomlSections(current);
    return `${withoutMurmur === "" ? "" : `${withoutMurmur}\n\n`}${codexServerBlock(url)}\n`;
  }

  try {
    const portableContent: string = removeStaticCodexContextHeaders(current, section);
    const portableSection: TomlSection | undefined = tomlSections(portableContent).find(
      (candidate: TomlSection): boolean => murmurTomlSectionKind(candidate.name) === "root",
    );
    if (portableSection === undefined) throw new Error("Codex Murmur configuration disappeared");
    return addCodexClientHeader(portableContent, portableSection);
  } catch (error: unknown) {
    if (!replace) throw error;
    const withoutMurmur: string = removeMurmurTomlSections(current);
    return `${withoutMurmur === "" ? "" : `${withoutMurmur}\n\n`}${codexServerBlock(url)}\n`;
  }
}
