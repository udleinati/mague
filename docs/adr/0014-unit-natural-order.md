# ADR 0014 - Ordem natural das designações de frações

## Contexto

Os condomínios identificam as frações por **designações** curtas (`unit.designation`): `"A"`, `"B"`,
`"AA"`, `"3ºE"`, `"Garagem 5"`. A coluna é `varchar(50)`, sem estrutura imposta.

Em listagens (admin, portal, PDFs) espera-se a ordem da vida real, igual à das colunas de uma folha
de cálculo - **comprimento crescente primeiro, depois alfabético**:

```
A, B, C, …, Z, AA, AB, …, AAA, AAB, …
```

Um `ORDER BY designation` simples (lexicográfico) produz `A, AA, AAA, AB, B, BA, …`: "AA" fica antes
de "B".

## Decisão

A ordem é definida **na API, em SQL**, pelo helper
[`unitNaturalOrder`](../../src/apps/api/libs/postgres/order_by.ts):

```ts
export function unitNaturalOrder(col: AnyColumn) {
  return [sql`length(${col})`, asc(col)];
}
```

Dois critérios: comprimento ASC ("A" < "AA" < "AAA") e, dentro do mesmo comprimento, valor ASC ("AA"
< "AB").

Aplica-se a qualquer query que ordene por `unit.designation` ou por uma cópia dela
(`budget_quota_map.unit_designation`). Exemplos em `src/apps/api/modules/admin/`:

- Drizzle relational: `orderBy: unitNaturalOrder(schema.unit.designation)` (`unit/list.ts`).
- Drizzle query builder: `.orderBy(...unitNaturalOrder(schema.budgetQuotaMap.unitDesignation))`
  (`budget/quota_map.ts`).
- SQL raw: `ORDER BY length(designation), designation` (`insurance/read_model.ts`).

O panel não reordena listas de frações que vêm da API.

Quando a lista é montada em memória (não sai de um `ORDER BY`), aplica-se a mesma regra em
TypeScript:

```ts
a.length - b.length || a.localeCompare(b, "pt");
```

Casos existentes: `naturalUnitCompare` em `src/apps/api/modules/admin/assembly/minutes_pdf.ts`; no
panel, o preview de import de frações em `controllers/units.ts` (as linhas vêm do parse do ficheiro,
não da API) e a lista de presenças em `controllers/assembly.ts` (a API devolve as presenças por
ordem de registo).

## Consequências

- A ordem é a mesma para qualquer consumidor da API (panel, PDFs, testes).
- O helper não aplica `lower()`: assume designações em maiúsculas.
- Designações livres que fogem ao padrão de folha de cálculo (`"Loja 1"`, `"Garagem A"`, `"Box 3"`)
  ficam numa ordem estável mas nem sempre intuitiva (`"Box 3"` antes de `"Loja 1"` por ter menos
  caracteres). Compromisso aceite: não há esquema universalmente intuitivo.
- O helper é específico para designações de frações; não se usa noutras tabelas.

## Como verificar drift

```bash
grep -rn "ORDER BY .*\\.\\?designation\\b\\|asc(.*\\.designation)" src/ \
  | grep -vi "length(" | grep -v unitNaturalOrder
```

Qualquer resultado é candidato a corrigir.

## Alternativas rejeitadas

1. **Coluna shadow com padding** (`"00A"`, `"00AA"`). Exige manter `designation` e a coluna shadow
   em sync; mais complexo do que `length(col)` no `ORDER BY`.
2. **`COLLATE` custom** com regra natural. Exige instalar uma collation própria no Postgres, para
   pouco retorno.
3. **Ordenar em JavaScript no panel.** Duplica a regra em cada controller e deixa a API a devolver
   ordem lexicográfica a qualquer consumidor fora do panel.

## Sinais de alerta para code review

- `ORDER BY designation` (SQL raw) ou `asc(designation)` sem `length(...)` antes.
- Um controller do panel a reordenar uma lista de frações que veio da API.

## Referências

- [`order_by.ts`](../../src/apps/api/libs/postgres/order_by.ts) - helper `unitNaturalOrder`.
- [`api_admin_unit_test.ts`](../../test_api/api_admin_unit_test.ts) - teste "retorna frações em
  ordem natural".
