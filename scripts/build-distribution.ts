import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  DistributionManifestSchema,
  distributionPackageVersion,
  type DistributionManifest,
} from "../src/domain/distribution-contracts.js";
import { MurmurRevisionSchema } from "../src/domain/upgrade-contracts.js";
import { distributionNotices } from "./lib/distribution-notices.js";

const ENTRYPOINTS: readonly string[] = [
  "src/cli.ts",
  "src/e2ee-proxy.ts",
  "src/hook.ts",
  "src/server.ts",
];

export async function buildDistribution(
  outputDirectory: string,
  revision: string,
): Promise<DistributionManifest> {
  const sourceRevision: string = MurmurRevisionSchema.parse(revision);
  const built: Bun.BuildOutput = await Bun.build({
    entrypoints: [...ENTRYPOINTS],
    metafile: true,
    minify: true,
    naming: "[name].js",
    packages: "bundle",
    sourcemap: "none",
    target: "bun",
  });
  if (!built.success || built.metafile === undefined) {
    throw new Error("Public distribution bundle failed");
  }
  const files: Record<string, string> = {};
  for (const output of built.outputs) {
    if (output.kind !== "entry-point") throw new Error("Unexpected public distribution output");
    files[`package/bin/${basename(output.path)}`] = await output.text();
  }
  files["package/package.json"] = `${JSON.stringify(
    {
      name: packageMetadata.name,
      version: distributionPackageVersion(packageMetadata.version),
      description: packageMetadata.description,
      license: packageMetadata.license,
      type: "module",
      engines: packageMetadata.engines,
      bin: {
        murmur: "./bin/cli.js",
        "murmur-e2ee-proxy": "./bin/e2ee-proxy.js",
        "murmur-hook": "./bin/hook.js",
        "murmur-mcp": "./bin/server.js",
      },
      murmur: { revision: sourceRevision, version: packageMetadata.version },
    },
    null,
    2,
  )}\n`;
  files["package/LICENSE"] = readFileSync("LICENSE", "utf8");
  files["package/THIRD_PARTY_NOTICES.txt"] = distributionNotices(
    Object.keys(built.metafile.inputs),
  );
  files["package/README.md"] =
    "# Murmur\n\nRun `murmur setup --user` to configure Codex and Claude Code. Connect an MCP client to `murmur-mcp` and call `get_setup_guide` for complete setup, hooks, and feature instructions. Requires Bun 1.3.14 or newer.\n\nMurmur is open source under the MIT License. Source: https://github.com/mattpatagon/murmur. This package contains executable bundles. See LICENSE and THIRD_PARTY_NOTICES.txt.\n";
  const archive: Bun.Archive = new Bun.Archive(files, { compress: "gzip", level: 9 });
  const blob: Blob = await archive.blob();
  const bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  const manifest: DistributionManifest = DistributionManifestSchema.parse({
    bytes: bytes.byteLength,
    revision: sourceRevision,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: packageMetadata.version,
  });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "murmur.tgz"), bytes);
  writeFileSync(join(outputDirectory, "release.json"), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

if (import.meta.main) {
  const revision: string | undefined = process.env["MURMUR_RELEASE_REVISION"];
  if (revision === undefined)
    throw new Error("MURMUR_RELEASE_REVISION is required to build a public distribution");
  const manifest: DistributionManifest = await buildDistribution(resolve("dist/public"), revision);
  process.stdout.write(`Public Murmur ${manifest.version} distribution: ${manifest.bytes} bytes\n`);
}
