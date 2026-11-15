import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

export function addRoute<Route extends ReturnType<typeof createRoute>>(
  app: OpenAPIHono,
  route: Route,
): void {
  app.openapi(route, (c) => c.text("not implemented", 501) as never);
}
