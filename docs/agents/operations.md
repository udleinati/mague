# Operations

Detalhes operacionais - testes, backup, rate-limit. `CLAUDE.md` aponta para aqui em vez de inflar
com detalhes.

## Testes - pirâmide

1. **TS unit** (`deno task test:unit`) - algoritmos puros, sem DB nem HTTP. Base.
2. **pgTAP** (`deno task test:sql`) - invariantes ao nível do schema (constraints, audit log, ledger
   immutability, view aggregations, FCR split nas funções `finance.fn_X` que ainda emitem ledger).
   **NÃO usar para testar cascade de state** - charge state machine + bank_tx status vivem em TS
   (ADR 0001); replicar em SQL traz drift garantido.
3. **test:api** (`deno task test:api`) - HTTP contra a API real. Valida o cascade completo (TS
   handlers + DB triggers + Valkey).

## TS unit (`deno task test:unit`)

Convenção: `<modulo>_test.ts` ao lado de `<modulo>.ts`. Precisam do `.env` na raiz (a configuração
exige `DATABASE_URL`, mesmo sem ligar à BD) e os testes de views do Panel precisam de
`PANEL_CONDOMINIUM_ID` definido (ex.: `PANEL_CONDOMINIUM_ID=c1 deno task test:unit`).

```bash
deno task test:unit                  # todos
deno task test:unit:watch            # TDD-friendly
deno task test:all                   # unit + sql + api (CI)
```

Exemplos: `src/apps/api/modules/admin/allocation/plan_test.ts`,
`src/apps/api/modules/admin/budget/quota_distribution_test.ts`,
`src/apps/api/modules/admin/recurring_template/date_helpers_test.ts`, `src/shared/nif_test.ts`,
`src/apps/panel/portal/owner_balance_test.ts`. Modelo de extração de helpers puros:
`quota_distribution.ts`.

## pgTAP (`deno task test:sql`)

Via `pg_prove` numa imagem runner (`mague-pgtap`). Cada ficheiro em `test_sql/tests/*.sql` começa
com `BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;` - isolado, sem afetar dados
persistentes.

```bash
deno task test:up              # reset: migrate + seed + pgTAP + build runner
deno task test:up:minimum      # idem com seeds_minimal (mais rápido)
deno task test:sql             # corre todos
./test_sql/run.sh "/tests/0018_*.sql"   # subconjunto (glob relativo a /tests/ no container)
deno task test:down            # destrói TUDO (containers + volumes + rede)
```

Notas:

- `test:up` **assume** containers a correr. Após `test:down`, faz `docker compose up -d` primeiro.
- pgTAP é volátil: desaparece após `test:down` ou restore de dump. Reinstala:
  `docker exec mague-db psql -U mague -d mague -c "CREATE EXTENSION IF NOT EXISTS pgtap;"`.
- O glob de `run.sh` é relativo a `/tests/` **dentro do container runner** - `"/tests/0005_*.sql"`,
  não `"test_sql/tests/0005_*.sql"`.

## test:api (`deno task test:api`)

HTTP contra a API real - não é unit (precisa stack de pé). Valida o contrato HTTP + cascade real. Os
ficheiros `panel_*` e alguns `api_security_*` fazem pedidos HTTP ao Panel (`:3400`), sem browser.

Pré-requisitos:

1. `docker compose up -d` - API em `http://localhost:3000`, Panel em `http://localhost:3400`,
   Mailpit em `http://localhost:8025`. As fixtures usam `docker exec mague-db psql`.
2. DB com seed completo ou mínimo (ambos criam `super@mague.pt` com a palavra-passe `test`). Se o DB
   tem dados de produção restaurados, `deno task test:up:minimum` reverte ao seed de testes -
   **apaga dados atuais**, confirma com o utilizador.
3. Antes da suite, `docker exec mague-valkey valkey-cli FLUSHDB` para evitar pollution do rate
   limiter.

```bash
deno task test:api                                              # todos
deno test --allow-net --allow-read --allow-env test_api/api_admin_charge_test.ts   # um ficheiro
deno test --allow-net --allow-read --allow-env test_api/api_admin_charge_test.ts \
  --filter "creates a charge"                                   # um teste
```

`test_api/_helpers/auth.ts` faz 1 login e reutiliza o JWT (`cachedToken`). Override do password
default via `SUPER_PASSWORD`.

## Rate limit (`deno task test:api:rate-limit`)

Standalone (fora de `test:api`) porque precisa limites production-like (5/100/300) que saturariam a
suite. O task: backup `.env` → baixa `LOGIN_RATE_LIMIT_*` → restart API → corre
`test_api/api_security_rate_limit_test.ts` com `RUN_RATE_LIMIT_TEST=1` → restaura `.env` + restart
(`trap` mesmo se falhar). Custo: ~20s extra. **Não está em `test:all`** - corre quando mexes em
rate-limit ou middleware de auth.

## Backup de produção

`deploy/postgres-backup.sh save|restore <ficheiro>|list`. Restore faz `DROP DATABASE` - confirma
antes. **Após restore corre sempre `deno task migrate`**: aplica as migrations que o dump ainda não
tinha e reaplica os components (funções, triggers, views), que no dump podem estar em versões
antigas.

## Schema: bootstrap e migrations

`src/db/migrations/001_bootstrap.sql` é o schema completo (gerado, não editar à mão). Mudanças de
schema entram como migrations novas (`002_...`); o loader regista cada ficheiro em `_migrations`
pelo nome. Ver [ADR 0008](../adr/0008-migrations-vs-components.md).

Para voltar a fundir as migrations acumuladas num bootstrap novo, parte de uma BD vazia com
`deno task migrate` aplicado e gera o dump:

```bash
docker exec mague-db pg_dump -U mague --schema-only --no-owner --no-privileges \
  --exclude-table=public._migrations mague
```

Ao resultado:

- retira as linhas `\restrict`/`\unrestrict` e o `SELECT pg_catalog.set_config('search_path', ...)`
  (este parte o `INSERT` do loader em `_migrations`);
- retira os blocos da extensão `pgtap` e os `COMMENT ON EXTENSION` (o bootstrap tem de correr num
  PostgreSQL sem pgTAP; a extensão é criada pelo `test:up`);
- troca `CREATE FUNCTION` por `CREATE OR REPLACE FUNCTION` (coexiste com os components `000_*`, que
  correm antes);
- acrescenta no fim os dados de referência (`audit.cdc_skip_list`).

Valida aplicando a cadeia antiga e o bootstrap novo a duas BDs vazias e comparando o `pg_dump` das
duas: só pode diferir a forma dos arrays nas `CHECK` constraints. Corre `deno task test:sql` nas
duas.

BDs que já existem têm de estar na última migration antes de receberem um bootstrap novo: o loader
só compara nomes de ficheiros e não aplica o que foi fundido.
