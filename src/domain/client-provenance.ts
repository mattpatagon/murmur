import { z } from "zod";

export const AgentClientNameSchema: z.ZodString = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/u,
    "Use 1-32 lowercase letters, numbers, or hyphens, starting with a letter",
  );

export type AgentClientName = z.infer<typeof AgentClientNameSchema>;
