import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "$config/env.ts";
import { errorHandler, notFoundHandler } from "./middleware/error.ts";
import { apiV1 } from "./modules/router.ts";
import type { ApiEnv } from "./middleware/api_auth.ts";

const app = new Hono<ApiEnv>();

// CORS - browsers de outros origins (ex: painel `fresh` em :3500) precisam disto.
// Lista de origins permitidos vem de env.CORS_ORIGINS (csv).
if (env.corsOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      // Apenas os headers que o panel envia: tudo passa por JWT Bearer (sem
      // x-role, x-session-id, x-condominium-id nem x-user-*).
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: false,
      maxAge: 86400,
    }),
  );
}

// Health check
app.get("/health", (c) => c.json({ status: "ok", env: env.environment }));

// API v1
app.route("/v1", apiV1);

app.onError(errorHandler);
app.notFound(notFoundHandler);

console.log(`Mague API a iniciar na porta ${env.port} (ambiente: ${env.environment})`);

Deno.serve({ port: env.port, hostname: "0.0.0.0" }, app.fetch);
