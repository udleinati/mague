import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { load } from "@std/dotenv";
import { addRoute } from "./helpers.ts";

// Todos os recursos documentados - sincronizar com os routers em
// src/apps/api/modules/*.
import authRoutes from "./routes/auth_doc.ts";
import condominiumRoutes from "./routes/condominium_doc.ts";
import unitRoutes from "./routes/unit_doc.ts";
import chartOfAccountRoutes from "./routes/chart_of_account_doc.ts";
import budgetRoutes from "./routes/budget_doc.ts";
import budgetLineRoutes from "./routes/budget_line_doc.ts";
import occupantRoutes from "./routes/occupant_doc.ts";
import unitOccupantRoutes from "./routes/unit_occupant_doc.ts";
import userRoutes from "./routes/user_doc.ts";
import managerRoutes from "./routes/manager_doc.ts";
import assemblyRoutes from "./routes/assembly_doc.ts";
import chargeRoutes from "./routes/charge_doc.ts";
import supplierRoutes from "./routes/supplier_doc.ts";
import recurringTemplateRoutes from "./routes/recurring_template_doc.ts";
import bankAccountRoutes from "./routes/bank_account_doc.ts";
import bankTransactionRoutes from "./routes/bank_transaction_doc.ts";
import ticketRoutes from "./routes/ticket_doc.ts";
import receiptRoutes from "./routes/receipt_doc.ts";
import attachmentRoutes from "./routes/attachment_doc.ts";

const ac = new AbortController();
await load({ envPath: "./src/apps/docs/.env", export: true });

const app = new OpenAPIHono();

for (const route of authRoutes) addRoute(app, route);
for (const route of condominiumRoutes) addRoute(app, route);
for (const route of unitRoutes) addRoute(app, route);
for (const route of chartOfAccountRoutes) addRoute(app, route);
for (const route of budgetRoutes) addRoute(app, route);
for (const route of budgetLineRoutes) addRoute(app, route);
for (const route of occupantRoutes) addRoute(app, route);
for (const route of unitOccupantRoutes) addRoute(app, route);
for (const route of userRoutes) addRoute(app, route);
for (const route of managerRoutes) addRoute(app, route);
for (const route of assemblyRoutes) addRoute(app, route);
for (const route of chargeRoutes) addRoute(app, route);
for (const route of supplierRoutes) addRoute(app, route);
for (const route of recurringTemplateRoutes) addRoute(app, route);
for (const route of bankAccountRoutes) addRoute(app, route);
for (const route of bankTransactionRoutes) addRoute(app, route);
for (const route of ticketRoutes) addRoute(app, route);
for (const route of receiptRoutes) addRoute(app, route);
for (const route of attachmentRoutes) addRoute(app, route);

// Bearer JWT - Authorization: Bearer <jwt>
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

app.doc("/doc/json", {
  servers: [
    { url: "https://api.mague.pt/v1", description: "Produção" },
    { url: "http://localhost:3000/v1", description: "Desenvolvimento local" },
  ],
  openapi: "3.1.0",
  info: {
    title: "Mague API",
    version: "1.0.0",
    description: "API para gestão de condomínios em Portugal.\n\n" +
      "**Autenticação**: `POST /auth/login` devolve um JWT HS256. Passa-o em `Authorization: Bearer <jwt>` em todas as rotas que não `/auth/*`.\n\n" +
      "**Escopos**:\n" +
      "- `/super/*` - apenas role `super`; gere condomínios globalmente.\n" +
      "- `/admin/condominiums/{cid}/*` - role `manager` (só dos seus) ou `super` (qualquer). O cid está sempre no path.\n" +
      "- `/auth/*` - público (login) ou qualquer sessão autenticada (me, logout, change-password).",
  },
  security: [{ bearerAuth: [] }],
});

app.get("/doc", swaggerUI({ url: "/doc/json" }));

const port = parseInt(Deno.env.get("PORT") || "8000");
Deno.serve({ signal: ac.signal, port }, app.fetch);

const response = await fetch(`http://localhost:${port}/doc/json`);
const json = await response.text();

await Deno.mkdir("./static/docs", { recursive: true });
await Deno.writeTextFile("./static/docs/swagger.json", json);

if (Deno.env.get("ENV") !== "local") {
  ac.abort();
}
