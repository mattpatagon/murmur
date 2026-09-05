import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { compareText } from "./deterministic-order.js";

const PackageNoticeSchema: z.ZodObject<{ name: z.ZodString; version: z.ZodString }> = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
});

// postgres declares Unlicense in its package metadata but omits a separate license file.
const UNLICENSE: string = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this
software, either in source code form or as a compiled binary, for any purpose,
commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this
software dedicate any and all copyright interest in the software to the public
domain. We make this dedication for the benefit of the public at large and to
the detriment of our heirs and successors. We intend this dedication to be an
overt act of relinquishment in perpetuity of all present and future rights to
this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>`;

function dependencyDirectory(inputPath: string): string | null {
  const normalized: string = inputPath.replaceAll("\\", "/");
  if (!normalized.includes("node_modules/")) return null;
  let directory: string = dirname(resolve(inputPath));
  for (let depth: number = 0; depth < 30; depth += 1) {
    const manifestPath: string = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (PackageNoticeSchema.safeParse(raw).success) return directory;
    }
    const parent: string = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("A bundled dependency has no package metadata");
}

export function distributionNotices(inputs: readonly string[]): string {
  const directories: Set<string> = new Set<string>();
  for (const input of inputs) {
    const directory: string | null = dependencyDirectory(input);
    if (directory !== null) directories.add(directory);
  }
  const notices: string[] = [];
  for (const directory of [...directories].sort(compareText)) {
    const raw: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const metadata: z.infer<typeof PackageNoticeSchema> = PackageNoticeSchema.parse(raw);
    const names: string[] = readdirSync(directory)
      .filter((name: string): boolean => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu.test(name))
      .sort(compareText);
    const contents: string[] = [];
    if (names.length === 0) {
      if (z.object({ license: z.literal("Unlicense") }).safeParse(raw).success) {
        contents.push(UNLICENSE);
      } else {
        throw new Error(`Bundled dependency lacks license: ${metadata.name}`);
      }
    }
    for (const name of names) {
      const path: string = join(directory, name);
      if (!statSync(path).isFile() || statSync(path).size > 512 * 1024) {
        throw new Error("Bundled dependency license is not a bounded regular file");
      }
      contents.push(`${name}\n${readFileSync(path, "utf8")}`);
    }
    notices.push(`${metadata.name} ${metadata.version}\n${contents.join("\n\n")}`);
  }
  return `${notices.sort(compareText).join("\n\n----------------------------------------\n\n")}\n`;
}
