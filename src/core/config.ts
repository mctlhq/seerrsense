import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const ConfigSchema = z.object({
  SEERR_URL: z.string().url().default("http://127.0.0.1:5055"),
  SEERR_API_KEY: z.string().min(1, "SEERR_API_KEY is required"),
  SEERRSENSE_LOCALE: z.string().default("en-US"),
  SEERRSENSE_AUTH_TOKEN: z.string().min(1, "SEERRSENSE_AUTH_TOKEN is required"),
  PORT: z.coerce.number().default(8787),
  NEBIUS_API_KEY: z.string().min(1).optional(),
  NEBIUS_MODEL: z.string().optional(),
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

let config: Config;

try {
  config = parseConfig(process.env);
} catch (err: any) {
  console.error("Invalid configuration:", err.errors || err.message);
  process.exit(1);
}

export { config };
