import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

function property(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a workflow mapping");
  }
  return Reflect.get(value, name);
}

test("every production job rejects manually dispatched branches and tags before authorization", (): void => {
  const directory: URL = new URL("../.github/workflows/", import.meta.url);
  let protectedJobs: number = 0;
  for (const filename of readdirSync(directory)) {
    if (!filename.endsWith(".yml") && !filename.endsWith(".yaml")) continue;
    const workflow: unknown = Bun.YAML.parse(readFileSync(new URL(filename, directory), "utf8"));
    const jobs: unknown = property(workflow, "jobs");
    if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
      throw new Error("Expected workflow jobs");
    }
    for (const jobName of Object.keys(jobs)) {
      const job: unknown = property(jobs, jobName);
      const environment: unknown = property(job, "environment");
      if (environment === undefined) continue;
      const environmentName: unknown =
        typeof environment === "string" ? environment : property(environment, "name");
      if (environmentName !== "production") continue;
      expect(property(job, "if")).toBe(`\${{ github.ref == 'refs/heads/main' }}`);
      protectedJobs += 1;
    }
  }
  expect(protectedJobs).toBeGreaterThanOrEqual(2);
});

test("every production deploy pins service-wide scaling and per-instance resources", (): void => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"),
  );
  const steps: unknown = property(property(property(workflow, "jobs"), "deploy"), "steps");
  if (!Array.isArray(steps)) throw new Error("Expected deployment steps");
  let deployments: number = 0;
  for (const step of steps) {
    const script: unknown = property(step, "run");
    if (typeof script !== "string" || !script.includes("gcloud run deploy")) continue;
    expect(script).toMatch(/--max\s+1\s/u);
    expect(script).toMatch(/--max-instances\s+1\s/u);
    expect(script).toMatch(/--cpu\s+1\s/u);
    expect(script).toMatch(/--memory\s+512Mi\s/u);
    deployments += 1;
  }
  expect(deployments).toBe(2);
});
