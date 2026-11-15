// Extrai path params obrigatórios. "Param em falta" só acontece se o handler
// estiver montado numa rota sem esse param (erro de programação, não de input);
// o 400 é defensivo vs. devolver `undefined` que estoura mais à frente.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";

export function requireParam(ctx: Context, name: string): string {
  const value = ctx.req.param(name);
  if (!value) {
    throw new AppError({
      message: `${name} é obrigatório`,
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  return value;
}
