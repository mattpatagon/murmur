import { z } from "zod";
import { MurmurRevisionSchema, MurmurVersionSchema } from "./upgrade-contracts.js";

export const PUBLIC_DOWNLOAD_PATH: string = "/downloads/murmur.tgz";
export const MAX_DISTRIBUTION_BYTES: number = 16 * 1024 * 1024;

export type DistributionManifest = {
  readonly bytes: number;
  readonly revision: string;
  readonly sha256: string;
  readonly version: string;
};

export const DistributionManifestSchema: z.ZodType<DistributionManifest> = z.strictObject({
  bytes: z.number().int().positive().max(MAX_DISTRIBUTION_BYTES),
  revision: MurmurRevisionSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version: MurmurVersionSchema,
});

export function distributionDownloadPath(version: string, revision: string): string {
  return `/downloads/murmur-${MurmurVersionSchema.parse(version)}-${MurmurRevisionSchema.parse(revision)}.tgz`;
}

export function distributionPackageVersion(version: string): string {
  const parts: string[] = MurmurVersionSchema.parse(version).split(".");
  return `${parts.slice(0, 3).join(".")}-build.${parts[3]}`;
}
