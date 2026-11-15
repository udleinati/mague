import type { MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/**
 * Valida e pré-carrega o body JSON: 415 sem `application/json`, 400 se inválido.
 * O parse fica em cache no Hono (c.req.json() subsequente reutiliza).
 */
export function parseJson(): MiddlewareHandler {
  return async (c, next) => {
    if (METHODS_WITH_BODY.has(c.req.method)) {
      const contentType = c.req.header("content-type") ?? "";
      // multipart/form-data é aceite: handler lê via c.req.formData() diretamente.
      if (contentType.includes("multipart/form-data")) {
        await next();
        return;
      }
      if (!contentType.includes("application/json")) {
        throw new HttpError(415, "Content-Type deve ser application/json");
      }
      try {
        await c.req.json();
      } catch {
        throw new HttpError(400, "JSON inválido no corpo do pedido");
      }
    }
    await next();
  };
}
