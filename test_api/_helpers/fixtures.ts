// Builder fluent para test fixtures partilhadas pelos testes E2E em test_api/.
//
// ─── QUANDO USAR ────────────────────────────────────────────────────────────
// Setup boilerplate idêntico em vários testes:
//   - createCondominium → createUnit(s) → INSERT occupant + unit_occupant
//   - O setup serve só para ter "um condo com X units e Y occupants" sobre os
//     quais o teste vai exercitar a API. Os dados específicos do teste (e.g.
//     a charge/policy/budget a ser criada) ficam fora do builder.
//
// Uso típico:
//
//     const fx = await seedScenario(client, auth)
//       .withCondo("Insurance E2E")
//       .withUnit({ designation: "A1", permillage: 1000 })
//       .withOccupant({ name: "Alice", email: "alice@test.pt", unitDesignation: "A1" })
//       .build();
//
//     // ... testes que usam fx.condominium / fx.units[0] / fx.occupants[0]
//
//     await fx.cleanup();
//
// ─── QUANDO NÃO USAR ────────────────────────────────────────────────────────
// Cenários cujo setup tem lógica específica:
//   - Inserção SQL com colunas adicionais (user_id, attachment, policy com
//     valid_from específico, etc.). O builder não cobre estas variantes para
//     evitar virar um deus-helper.
//   - Setup multi-condo (cross-tenant), ou onde os designations das units são
//     gerados dinamicamente, ou onde o teste precisa de IDs determinísticos
//     por run (e.g. retries de teardown).
//   - Quando o teste precisa de manipular o occupant DEPOIS de criado (e.g.
//     marcar receiveReceiptEmails=false antes do teste). Para isso, usa o
//     builder só para a parte boilerplate e adiciona o SQL específico fora.
//
// Filosofia: builder cobre o caso comum (90%) sem perder type-safety nem
// forçar o resto dos testes a passar por aqui. Não tentamos generalizar
// para todos os cenários - quem precisa de mais flexibilidade continua a
// fazer setup manual (e mais explícito).

import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { sqlExec } from "./db.ts";

/** Resultado de `ScenarioBuilder.build()`. Mantém referências às entidades
 *  criadas + um `cleanup()` que devolve o ambiente ao estado inicial. */
export interface ScenarioFixture {
  /** Condomínio criado. `condominium.id` é o cid a passar em headers. */
  condominium: Condominium;
  /** Units criadas pela ordem em que `withUnit()` foi chamado. */
  units: Unit[];
  /** Occupants criados pela ordem em que `withOccupant()` foi chamado.
   *  IDs gerados são prefixados `occ_` para facilitar debug no DB. */
  occupants: Array<{ id: string; name: string; email: string | null }>;
  /** Headers prontos para chamadas /admin/c/:cid/... (combina auth + cid). */
  hdr: () => Record<string, string>;
  /** Apaga o condomínio (soft-delete via API super). Suficiente para a
   *  maioria dos casos - units e occupants ficam órfãos com `deletedAt`
   *  no condo, mas isso não afeta runs subsequentes (queries filtram por
   *  condominium.deletedAt). */
  cleanup: () => Promise<void>;
}

interface UnitSpec {
  designation: string;
  permillage: number;
  description?: string;
}

interface OccupantSpec {
  name: string;
  email?: string;
  nif?: string;
  /** Designação de uma unit declarada anteriormente via `withUnit()`. Se
   *  omitido, o occupant é criado sem ligação a nenhuma fração (caso raro
   *  - tipicamente queremos sempre owner de alguma unit). */
  unitDesignation?: string;
  /** Default: "owner". */
  relationshipType?: "owner" | "tenant" | "resident";
}

export class ScenarioBuilder {
  private condoName = "Test Condo";
  private unitSpecs: UnitSpec[] = [];
  private occupantSpecs: OccupantSpec[] = [];

  constructor(
    private readonly client: Client,
    private readonly auth: { Authorization: string },
  ) {}

  /** Nome do condomínio. Default: "Test Condo". Em runs em paralelo (CI)
   *  considera incluir um timestamp para evitar colisões visuais nos logs. */
  withCondo(name: string): this {
    this.condoName = name;
    return this;
  }

  /** Adiciona uma fração ao cenário. Default permillage = 1000 (cobre o
   *  caso de 1-unit-só-no-condo onde queremos 100% da participação). */
  withUnit(spec: { designation: string; permillage?: number; description?: string }): this {
    this.unitSpecs.push({
      designation: spec.designation,
      permillage: spec.permillage ?? 1000,
      description: spec.description,
    });
    return this;
  }

  /** Adiciona um occupant ao cenário. Se `unitDesignation` corresponder a
   *  uma unit já declarada, cria-se também a linha `unit_occupant`. Caso
   *  contrário (ou quando omitido), o occupant fica solto - útil para testar
   *  ownership-less flows ou criar occupants para mais tarde ligar manualmente.
   *
   *  Nota: a inserção é via `sqlExec` (não pela API) por dois motivos:
   *   1. Não existe endpoint admin público para criar occupant com `user_id`
   *      pré-existente.
   *   2. Replicamos exactamente o pattern que 21+ testes já fazem. */
  withOccupant(spec: OccupantSpec): this {
    this.occupantSpecs.push({
      ...spec,
      relationshipType: spec.relationshipType ?? "owner",
    });
    return this;
  }

  /** Executa o setup contra a API+DB e devolve o fixture. */
  async build(): Promise<ScenarioFixture> {
    // 1. Condomínio
    const { data: condo } = await this.client.super.createCondominium(
      { name: this.condoName },
      { headers: this.auth },
    );

    // 2. Units (sequencial - ordem importa para `unitDesignation` lookup)
    const units: Unit[] = [];
    for (const spec of this.unitSpecs) {
      const body: Record<string, unknown> = {
        designation: spec.designation,
        permillage: spec.permillage,
      };
      if (spec.description !== undefined) body.description = spec.description;
      const { data } = await this.client.super.createUnit(condo.id, body, {
        headers: this.auth,
      });
      units.push(data);
    }

    // 3. Occupants via SQL direct (igual ao pattern já existente)
    const occupants: ScenarioFixture["occupants"] = [];
    for (const spec of this.occupantSpecs) {
      const occId = `occ_${crypto.randomUUID().slice(0, 8)}`;
      const emailSql = spec.email ? `'${escapeSqlString(spec.email)}'` : "NULL";
      const nifSql = spec.nif ? `'${escapeSqlString(spec.nif)}'` : "NULL";
      await sqlExec(
        `INSERT INTO core.occupant (id, condominium_id, name, email, nif) ` +
          `VALUES ('${occId}', '${condo.id}', '${
            escapeSqlString(spec.name)
          }', ${emailSql}, ${nifSql})`,
      );

      if (spec.unitDesignation) {
        const matchingUnit = units.find((u) => u.designation === spec.unitDesignation);
        if (!matchingUnit) {
          throw new Error(
            `withOccupant({ unitDesignation: "${spec.unitDesignation}" }) sem withUnit() prévio com a mesma designation`,
          );
        }
        const uoId = `uo_${crypto.randomUUID().slice(0, 8)}`;
        await sqlExec(
          `INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date) ` +
            `VALUES ('${uoId}', '${matchingUnit.id}', '${occId}', '${spec.relationshipType}', '2025-01-01')`,
        );
      }

      occupants.push({
        id: occId,
        name: spec.name,
        email: spec.email ?? null,
      });
    }

    const hdr = () => ({ ...this.auth, "x-condominium-id": condo.id });

    return {
      condominium: condo,
      units,
      occupants,
      hdr,
      cleanup: async () => {
        // Soft-delete do condo via API. Suficiente: o resto fica encapsulado
        // por `condominium.deletedAt` nas queries downstream.
        await this.client.super.deleteCondominium(condo.id, { headers: this.auth });
      },
    };
  }
}

/** Escapa apóstrofes para SQL (single-quoted literals). Aceitável para
 *  test fixtures onde os inputs vêm dos próprios testes (não de input
 *  externo). NÃO usar isto em código de produção. */
function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

/** Helper fluent: `seedScenario(client, auth).withCondo(...).build()`.
 *
 *  Ver JSDoc no topo do ficheiro para guidance sobre quando usar. */
export function seedScenario(
  client: Client,
  auth: { Authorization: string },
): ScenarioBuilder {
  return new ScenarioBuilder(client, auth);
}
