import { assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { AppError } from "$api/libs/error/app_error.ts";
import { errorHandler } from "./error.ts";

// O log de erros é onde se investiga um incidente: o cid tem de ser o do path
// que a API autorizou, não o header que o cliente escreve.
Deno.test("errorHandler: o log grava o cid do path, não o header x-condominium-id", async () => {
  const app = new Hono();
  app.get("/v1/admin/condominiums/:cid/boom", () => {
    throw new AppError({ message: "x", statusCode: 404, code: "NOT_FOUND" });
  });
  app.onError(errorHandler);

  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const res = await app.request("/v1/admin/condominiums/A/boom", {
      headers: { "x-condominium-id": "B" },
    });
    await res.body?.cancel();
  } finally {
    console.error = original;
  }

  assertStringIncludes(lines[0], "cid=A ");
});
