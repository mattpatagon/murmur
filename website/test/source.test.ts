import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  auditSource,
  auditWebsiteSources,
  collectSources,
  type SourceAudit,
  type SourceInput,
  type SourceViolation,
} from "../scripts/check-source.ts";

function messages(path: string, text: string): readonly string[] {
  return auditSource({ path, text }).map((violation: SourceViolation): string => violation.message);
}

function createWorkspace(files: Readonly<Record<string, string>>): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "murmur-website-source-"));
  for (const [path, text] of Object.entries(files)) {
    const absolutePath: string = join(workspace, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, text);
  }
  return workspace;
}

test("explicit TSX accepts typed props, event handlers, unknown catches, and narrowed values", (): void => {
  const source: string = [
    'import type { ReactElement } from "react";',
    "type Props = { readonly label: string; readonly count: number | null };",
    "export default function Example({ label, count }: Props): ReactElement {",
    "  const display: string = count === null ? label : String(count);",
    "  function click(): void {",
    "    try { console.log(display); } catch (error: unknown) {",
    "      if (error instanceof Error) console.log(error.name);",
    "    }",
    "  }",
    // biome-ignore lint/security/noSecrets: This is a literal JSX event-handler fixture, not credential material.
    "  return <button onClick={click}>{display}</button>;",
    "}",
  ].join("\n");
  expect(auditSource({ path: "src/components/Example.tsx", text: source })).toEqual([]);
});

test("TSX rejects assertion, implicit typing, optional-chain, and any escape hatches", (): void => {
  const source: string = [
    "declare const candidate: { value: string; call: () => void } | null;",
    "const implicit = candidate?.value as string;",
    "const element: string | undefined = candidate?.['value'];",
    "const call: void = candidate?.call?.();",
    "const definite: string = candidate!.value;",
    "const escaped: any = implicit;",
    "const handler: (input: string) => string = (input) => input;",
    "class Example { value = 1; definite!: string; method() { return 1; } }",
    "try { throw new Error('failure'); } catch (error) { console.log(error); }",
    "export function Component() { return <div>{escaped}</div>; }",
  ].join("\n");
  const failures: readonly string[] = messages("src/components/Unsafe.tsx", source);
  for (const message of [
    "Type assertions are forbidden; validate or narrow the value.",
    "Non-null assertions are forbidden; narrow the value explicitly.",
    "Optional chaining is forbidden; narrow the value explicitly.",
    "The any type is forbidden.",
    "Variable declarations require an explicit type.",
    "Parameters require an explicit type.",
    "Class properties require an explicit type.",
    "Functions and methods require an explicit return type.",
    "Catch variables require an explicit unknown type.",
  ]) {
    expect(failures).toContain(message);
  }
});

test("TypeScript angle-bracket assertions and non-unknown catch annotations fail", (): void => {
  expect(messages("src/value.ts", "const value: string = <string>input;")).toContain(
    "Type assertions are forbidden; validate or narrow the value.",
  );
  expect(messages("src/value.ts", "try {} catch (error: Error) {} ")).toContain(
    "Catch variables require an explicit unknown type.",
  );
});

test("the repository's for-of and for-in initializer exception remains supported", (): void => {
  expect(
    messages(
      "src/iteration.ts",
      'const values: readonly string[] = ["one"]; for (const value of values) { void value; } for (const key in values) { void key; }',
    ),
  ).toEqual([]);
});

test("Astro frontmatter keeps original CRLF line and column diagnostics", (): void => {
  const failures: readonly SourceViolation[] = auditSource({
    path: "src/pages/unsafe.astro",
    text: ["---", "const value = 1;", "---", "<p>{value}</p>", ""].join("\r\n"),
  });
  expect(failures).toEqual([
    {
      path: "src/pages/unsafe.astro",
      line: 2,
      column: 7,
      message: "Variable declarations require an explicit type.",
    },
  ]);
});

test("Astro frontmatter enforces the same assertion and typing rules as TypeScript", (): void => {
  const failures: readonly string[] = messages(
    "src/pages/unsafe.astro",
    [
      "---",
      "const { title } = Astro.props;",
      "const value: any = Astro.props?.title as string;",
      "function render(input) { return input!.label; }",
      "---",
      "<h1>{title}</h1>",
    ].join("\n"),
  );
  expect(failures).toContain("The any type is forbidden.");
  expect(failures).toContain("Variable declarations require an explicit type.");
  expect(failures).toContain("Parameters require an explicit type.");
  expect(failures).toContain("Functions and methods require an explicit return type.");
  expect(failures).toContain("Type assertions are forbidden; validate or narrow the value.");
  expect(failures).toContain("Non-null assertions are forbidden; narrow the value explicitly.");
  expect(failures).toContain("Optional chaining is forbidden; narrow the value explicitly.");
});

test("Astro accepts typed frontmatter, including a BOM, and pages without frontmatter", (): void => {
  expect(
    messages(
      "src/pages/valid.astro",
      [
        "\uFEFF---",
        "interface Props { title: string }",
        "const { title }: Props = Astro.props;",
        "---",
        "<h1>{title}</h1>",
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(messages("src/pages/plain.astro", "<h1>Plain HTML</h1>")).toEqual([]);
});

test("Astro fails closed on missing frontmatter delimiter and malformed TypeScript", (): void => {
  expect(messages("src/pages/broken.astro", "---\nconst value: string = 'hello';")).toContain(
    "Astro frontmatter must have a closing delimiter.",
  );
  const failures: readonly string[] = messages(
    "src/pages/broken.astro",
    "---\nconst value: = ;\n---\n<p>Hello</p>",
  );
  expect(
    failures.some((message: string): boolean => message.startsWith("Invalid TypeScript syntax:")),
  ).toBe(true);
});

test("Astro refuses inline, external, and mixed-case script tags outside frontmatter", (): void => {
  for (const template of [
    "<script>const unsafe = 1;</script>",
    '<script src="/unchecked.js"></script>',
    "<ScRiPt is:inline>window.run()</ScRiPt>",
  ]) {
    expect(
      messages("src/pages/unsafe.astro", `---\nconst ready: boolean = true;\n---\n${template}`),
    ).toContain(
      "Authored Astro script tags are forbidden; use checked TypeScript or React modules.",
    );
  }
});

test("JSX cannot bypass the script-tag boundary", (): void => {
  expect(
    messages(
      "src/components/unsafe.tsx",
      'export function Unsafe(): JSX.Element { return <script src="https://example.invalid/unchecked.js" />; }',
    ),
  ).toContain("Authored JSX script tags are forbidden; use checked TypeScript or React modules.");
});

test("TypeScript suppression directives fail in TSX, Astro frontmatter, and markup", (): void => {
  for (const suffix of ["ignore", "expect-error", "nocheck"]) {
    const directive: string = `@ts-${suffix}`;
    for (const source of [
      { path: "src/unsafe.tsx", text: `// ${directive}\nconst value: string = 1;` },
      { path: "src/unsafe.astro", text: `---\n// ${directive}\nconst value: string = 1;\n---` },
      { path: "src/unsafe.astro", text: `<!-- ${directive} -->\n<h1>Hello</h1>` },
    ]) {
      expect(messages(source.path, source.text)).toContain(
        "TypeScript suppression comments are forbidden.",
      );
    }
  }
});

test("census audits scripts, tests, config, and pages without executing their source", (): void => {
  const workspace: string = createWorkspace({
    "astro.config.ts": 'throw new Error("must never execute");',
    "src/pages/index.astro": "<h1>Murmur</h1>",
    "scripts/extra.ts": "export const ready: boolean = true;",
    "test/example.tsx": 'export const label: string = "Hello";',
    ".astro/generated.ts": "const ignored = 1;",
    "dist/bundle.js": "const ignored = 1;",
    "node_modules/package/index.ts": "const ignored = 1;",
    "src/generated/authored.ts": "export const included: boolean = true;",
  });
  try {
    const sources: readonly SourceInput[] = collectSources(workspace);
    expect(sources.map((source: SourceInput): string => source.path)).toEqual([
      "astro.config.ts",
      "scripts/extra.ts",
      "src/generated/authored.ts",
      "src/pages/index.astro",
      "test/example.tsx",
    ]);
    const audit: SourceAudit = auditWebsiteSources(workspace);
    expect(audit.checkedFiles).toBe(5);
    expect(audit.violations).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("census rejects empty projects and missing application entry points", (): void => {
  const workspace: string = createWorkspace({});
  try {
    expect((): SourceAudit => auditWebsiteSources(workspace)).toThrow("source census is empty");
    writeFileSync(join(workspace, "astro.config.ts"), "export {};");
    expect((): SourceAudit => auditWebsiteSources(workspace)).toThrow("src/pages/index.astro");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("census refuses unchecked JavaScript and oversized source files", (): void => {
  const workspace: string = createWorkspace({ "public/unchecked.js": "window.run();" });
  try {
    expect((): readonly SourceInput[] => collectSources(workspace)).toThrow("checked TypeScript");
    rmSync(join(workspace, "public/unchecked.js"));
    writeFileSync(join(workspace, "large.ts"), " ".repeat(1_048_577));
    expect((): readonly SourceInput[] => collectSources(workspace)).toThrow("file or byte limit");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("census refuses directory symlinks instead of reading outside the website", (): void => {
  const workspace: string = createWorkspace({});
  const outside: string = createWorkspace({ "external.ts": "const unsafe = 1;" });
  try {
    symlinkSync(outside, join(workspace, "linked"), "junction");
    expect((): readonly SourceInput[] => collectSources(workspace)).toThrow("symbolic link");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
