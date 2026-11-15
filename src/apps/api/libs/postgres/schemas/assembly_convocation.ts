import { jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";
import type { ConvocationSnapshot } from "$shared/assembly/convocation_snapshot.ts";

const schema = pgSchema("core");

/**
 * Resultado por destinatário. Envio POR FRAÇÃO (ADR 0034): chave lógica
 * `(occupantId, unitId)`, mesma pessoa N vezes. Runs antigos sem `unitId`
 * contam como "nunca enviado" no cooldown. `email` vazio = sem email (failed).
 */
export interface AssemblyConvocationRecipient {
  occupantId: string;
  /** Fração a que este despacho diz respeito (chave lógica = occupant+unit). */
  unitId: string;
  email: string;
  name: string;
  status: "sent" | "failed";
  sentAt: string;
  error?: string;
}

export const assemblyConvocation = schema.table("assembly_convocation", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  assemblyId: text("assembly_id").notNull(),
  condominiumId: text("condominium_id").notNull(),
  trigger: varchar("trigger", { length: 10 }).notNull(),
  recipients: jsonb("recipients")
    .$type<AssemblyConvocationRecipient[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  // O que foi anunciado neste envio (ordem do dia + textos + datas). Ver
  // `$shared/assembly/convocation_snapshot.ts`.
  snapshot: jsonb("snapshot").$type<ConvocationSnapshot>(),
  sentBy: actorColumn("sent_by").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  // Retificar a convocatória (scheduled -> draft) marca os runs ativos como
  // superseded: deixam de contar para o cooldown / "último envio" / "última
  // convocatória" (mas ficam para auditoria). NULL = run ativo.
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
});

export type AssemblyConvocationSelect = typeof assemblyConvocation.$inferSelect;
export type AssemblyConvocationInsert = typeof assemblyConvocation.$inferInsert;
