import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import { deleteSession } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";

// POST /v1/auth/logout
// Revoga a sessão em Valkey. Requer `Authorization: Bearer <jwt>`.
export const logout = async (ctx: Context) => {
  const sessionId = await extractSidFromBearer(ctx.req.header("authorization"));
  if (!sessionId) {
    throw new AppError({
      message: "Authorization Bearer obrigatório",
      statusCode: STATUS_CODE.Unauthorized,
      code: "NO_SESSION",
    });
  }
  await deleteSession(sessionId);
  return ctx.json({ data: { loggedOut: true } });
};
