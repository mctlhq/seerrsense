import { z } from "zod";
import dotenv from "dotenv";

// quiet: dotenv 17 prints an "injected env" banner to stdout, which would corrupt
// the JSON-RPC channel in stdio mode.
dotenv.config({ quiet: true });

const ConfigSchema = z.object({
  SEERR_URL: z.string().url().default("http://127.0.0.1:5055"),
  // Optional since a signed-in person can attach their own Seerr. Without it
  // there is simply no household instance to fall back on.
  SEERR_API_KEY: z.string().min(1).optional(),
  SEERRSENSE_LOCALE: z.string().default("en-US"),
  // Required for the HTTP server (enforced by assertHttpConfig), not for stdio mode
  // where the MCP client owns the process and there is no network surface.
  SEERRSENSE_AUTH_TOKEN: z.string().min(1).optional(),
  PORT: z.coerce.number().default(8787),
  // Ceiling on one request to a Seerr, trusted or attached. Reads that get no
  // answer within it are retried once (src/providers/seerr/client.ts).
  SEERR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(20_000),
  NEBIUS_API_KEY: z.string().min(1).optional(),
  NEBIUS_MODEL: z.string().optional(),
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),
  // Read here too so the tools can point a person at the right account page.
  SEERRSENSE_PUBLIC_URL: z.string().url().optional(),
  // The token OpenAI issues when a ChatGPT app is submitted; it proves the
  // domain is ours by being served verbatim at a well-known path. Absent
  // means the path is not served at all.
  SEERRSENSE_OPENAI_APPS_CHALLENGE: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

export type HttpConfig = Config & { SEERRSENSE_AUTH_TOKEN: string };

/** HTTP mode exposes /mcp and /api on the network, so the bearer token is mandatory. */
export function assertHttpConfig(cfg: Config): HttpConfig {
  if (!cfg.SEERRSENSE_AUTH_TOKEN) {
    throw new Error("SEERRSENSE_AUTH_TOKEN is required when running the HTTP server");
  }
  return cfg as HttpConfig;
}

let config: Config;

try {
  config = parseConfig(process.env);
} catch (err: any) {
  console.error("Invalid configuration:", err.issues ?? err.message);
  process.exit(1);
}

export { config };
