# ADR 0023 - Identificadores humanos: pattern base-36 (`<prefixo><dígitos>`)

## Contexto

Várias entidades precisam de um **identificador humano curto**, distinto do `id` opaco (nanoid):
algo que a administração diz ao telefone, que aparece num email, ou que um condómino escreve no
descritivo de uma transferência. Sem norma, cada entidade inventa o seu mecanismo - alfabetos
diferentes, funções de formatação duplicadas, prefixos que colidem.

Este ADR fixa o pattern e mantém a lista única de prefixos reservados. O número do recibo
(`AAAA/NNNNN`) tem formato próprio e fica fora deste pattern.

## Decisão

### Pattern

Cada entidade que adota o pattern tem uma coluna `code varchar(10)` com:

1. **Formato** `<prefixo><dígitos>`:
   - o prefixo é uma letra maiúscula reservada **globalmente** (tabela abaixo) e identifica a
     entidade ao olhar: `D0023` é uma despesa, `R00023` uma receita, `P023` uma patologia;
   - os dígitos são um número sequencial em base-36, com zeros à esquerda até à largura da entidade.
     Alfabeto: `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`. Inclui `0`/`O` e `1`/`I`, que se podem
     confundir; é aceite.
2. **CHECK** com regex `^<PREFIXO>[0-9A-Z]{<min>,}$` (aceita `NULL`).
3. **Unicidade por condomínio**: índice único em `(condominium_id, code)` com
   `WHERE code IS NOT NULL`.
4. **Tabela de contador dedicada** por entidade (`<schema>.<entity>_code_counter`), com
   `last_number` por condomínio. A chave inclui `prefix` quando a entidade tem mais do que um
   prefixo. O número seguinte obtém-se com um UPSERT atómico
   (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING last_number`): o row lock evita corridas sem
   locks na aplicação.
5. **Função de formatação** `core.fn_format_base36(n, prefix, min_width)`, `IMMUTABLE`.
6. **Trigger `BEFORE INSERT`** que atribui o código, definido num component. Fica em trigger, e não
   em TypeScript, para que qualquer INSERT receba código, venha de onde vier. Se `NEW.code` já vier
   preenchido (importação, backfill), o trigger respeita-o.
7. **Imutável e sem reciclagem**: o código não muda depois da criação, mantém-se em linhas
   eliminadas ou canceladas e nunca é reatribuído. A sequência é por condomínio, contínua, e não
   reinicia por ano.

### Prefixos reservados

Acrescentar uma linha a esta tabela faz parte de introduzir um prefixo novo. Colisão é bug. Os
components estão em `src/db/components/`.

| Prefixo | Entidade                               | Dígitos    | Component                     |
| ------- | -------------------------------------- | ---------- | ----------------------------- |
| `D`     | `finance.charge` (`kind='payable'`)    | 4 (fixo)   | `010_trg_charge_code.sql`     |
| `R`     | `finance.charge` (`kind='receivable'`) | 5 (fixo)   | `010_trg_charge_code.sql`     |
| `P`     | `core.pathology`                       | 3 (mínimo) | `017_trg_pathology_code.sql`  |
| `T`     | `core.ticket`                          | 3 (mínimo) | `018_trg_ticket_code.sql`     |
| `I`     | `core.inspection`                      | 3 (mínimo) | `019_trg_inspection_code.sql` |

Reservados sem implementação, para não serem usados por outra coisa: `Q` (cotações), `V`
(vouchers/recibos), `O` (encomendas).

Particularidades das charges: `D` e `R` têm sequências independentes (a chave do contador é
`(condominium_id, prefix)`), a CHECK impõe largura fixa (`^(D[0-9A-Z]{4}|R[0-9A-Z]{5})$`) e a
formatação é de `finance.fn_charge_code_format(n, prefix)`, que devolve `NULL` acima da capacidade
do prefixo.

### Capacidade e largura

| Dígitos | Códigos por condomínio (`36^N - 1`) |
| ------- | ----------------------------------- |
| 3       | 46 655                              |
| 4       | 1 679 615                           |
| 5       | 60 466 175                          |

**A largura não cresce sozinha.** `core.fn_format_base36` formata com `lpad`, que trunca acima de
`min_width`: esgotados os `36^min - 1` códigos de um condomínio, o código seguinte repete um
existente e o INSERT falha no índice único. Para alargar, aumenta-se o `min_width` que o trigger
passa (no component) antes de o limite ser atingido. A regex `{3,}` já aceita códigos mais largos e
os existentes não mudam. Nas charges, alargar implica também alterar a CHECK e
`finance.fn_charge_code_format`, por migration.

### Adotar o pattern numa entidade nova

1. Reservar o prefixo na tabela acima.
2. Migration nova com a coluna, a CHECK, o índice único e o contador:

   ```sql
   ALTER TABLE core.<entity> ADD COLUMN code varchar(10);

   ALTER TABLE core.<entity>
     ADD CONSTRAINT <entity>_code_format_check
     CHECK (code IS NULL OR code ~ '^<PREFIXO>[0-9A-Z]{3,}$');

   CREATE UNIQUE INDEX <entity>_code_unique
     ON core.<entity> (condominium_id, code)
     WHERE code IS NOT NULL;

   CREATE TABLE core.<entity>_code_counter (
     condominium_id text PRIMARY KEY,
     last_number    integer NOT NULL DEFAULT 0,
     updated_at     timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT <entity>_code_counter_positive CHECK (last_number >= 0)
   );
   ```

3. Se já houver linhas, o backfill vai na mesma migration:
   `row_number() OVER (PARTITION BY condominium_id ORDER BY created_at, id)` formatado com
   `core.fn_format_base36`, deixando `last_number` no maior número atribuído em cada condomínio.
4. Component `<NNN>_trg_<entity>_code.sql` com `core.fn_<entity>_assign_code()` e o trigger
   `trg_<entity>_code_assign`. Copiar de `017_trg_pathology_code.sql`.

## Consequências

- Um só mecanismo e uma só lista de prefixos, em vez de uma implementação por entidade.
- Códigos curtos com capacidade grande, sem reinício anual e sem partilha de sequência entre
  condomínios (`P001` de um condomínio é independente do `P001` de outro).
- O UPSERT do contador faz parte da transação do INSERT: um rollback não consome número, e INSERTs
  concorrentes da mesma entidade no mesmo condomínio esperam uns pelos outros.
- Cada entidade replica a tabela de contador e o trigger. É duplicação modesta, aceite.
- O limite de largura tem de ser vigiado (ver "Capacidade e largura").

## Alternativas rejeitadas

1. **UUID como identificador humano.** Ilegível e impossível de ditar ao telefone.
2. **NanoID público.** O mesmo problema.
3. **Sequência numérica simples** (`#1`, `#2`, ...). Menos compacta (base-10 precisa de 7 dígitos
   para o que base-36 faz em 4) e sem prefixo que distinga a entidade.
4. **Identificador baseado em timestamp** (estilo Snowflake). Não é precisa ordem temporal
   codificada no identificador.
5. **Crockford base-32** (omite os caracteres confundíveis). Mudaria todos os códigos existentes por
   um ganho marginal.
6. **Contador genérico** (`core.entity_code_counter` com `entity_type`). Acopla todas as entidades a
   uma tabela; qualquer alteração a ela toca em todas.

## Sinais de alerta para code review

- Coluna `code` nova sem CHECK de formato, ou com regex que não segue `^<PREFIXO>[0-9A-Z]{<min>,}$`.
- Contador com chave só `condominium_id` numa entidade com vários prefixos - falta `prefix` na
  chave.
- Trigger de atribuição em `AFTER INSERT` (obriga a um UPDATE reflexivo). Usar `BEFORE INSERT`.
- Código calculado na aplicação (contar linhas e somar 1) em vez do contador.
- UPDATE a `code` depois da criação, ou reutilização do código de uma linha eliminada.
- Prefixo novo sem linha na tabela deste ADR.

## Referências

- Triggers: [`010_trg_charge_code.sql`](../../src/db/components/010_trg_charge_code.sql),
  [`017_trg_pathology_code.sql`](../../src/db/components/017_trg_pathology_code.sql),
  [`018_trg_ticket_code.sql`](../../src/db/components/018_trg_ticket_code.sql),
  [`019_trg_inspection_code.sql`](../../src/db/components/019_trg_inspection_code.sql).
- Colunas, CHECKs, índices, contadores, `core.fn_format_base36` e `finance.fn_charge_code_format`:
  [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql).
- pgTAP: `test_sql/tests/0051_charge_code_trigger.sql`.
- [ADR 0008](./0008-migrations-vs-components.md) - triggers vivem em components.
- [ADR 0024](./0024-pathology-entity-design.md) - patologias.
- `CONTEXT.md`: "Entity code", "Charge code", "Pathology code".
