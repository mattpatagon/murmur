import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { prepareCloudSourceInstallation } from "./support/cloud-source-installation.js";

const SOURCE_ROOT: string = resolve(import.meta.dir, "..");

test("isolated cloud sources retain exact frozen dependency inputs and SDK patches", (): void => {
  const root: string = mkdtempSync(join(tmpdir(), "murmur-cloud-sources-"));
  const installation: string = join(root, "machine one", "installation");
  try {
    prepareCloudSourceInstallation(SOURCE_ROOT, installation);
    expect(readdirSync(installation).sort()).toEqual([
      "bun.lock",
      "bunfig.toml",
      "package.json",
      "patches",
      "src",
    ]);
    for (const name of ["package.json", "bun.lock", "bunfig.toml"]) {
      expect(readFileSync(join(installation, name))).toEqual(readFileSync(join(SOURCE_ROOT, name)));
    }
    for (const patch of Object.values(packageMetadata.patchedDependencies)) {
      expect(readFileSync(join(installation, patch))).toEqual(
        readFileSync(join(SOURCE_ROOT, patch)),
      );
    }
    for (const entrypoint of Object.values(packageMetadata.bin)) {
      expect(readFileSync(join(installation, entrypoint))).toEqual(
        readFileSync(join(SOURCE_ROOT, entrypoint)),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated cloud preparation refuses to replace existing installation files", (): void => {
  const root: string = mkdtempSync(join(tmpdir(), "murmur-cloud-existing-"));
  const installation: string = join(root, "installation");
  mkdirSync(installation);
  const manifest: string = join(installation, "package.json");
  writeFileSync(manifest, "existing installation");
  try {
    expect((): void => prepareCloudSourceInstallation(SOURCE_ROOT, installation)).toThrow();
    expect(readFileSync(manifest, "utf8")).toBe("existing installation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
