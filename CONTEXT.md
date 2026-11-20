# Mague - Domain Context

Vocabulário canónico do projeto. Sistema de gestão de condomínios em Portugal: contabilidade em
partidas dobradas, multi-tenant por condomínio, regime de competência. Os termos abaixo são
vinculativos - em código, comentários, commits, PRs e documentação. Aliases listadas em `_Avoid_`
devem ser substituídas pelo termo canónico.

> Cada definição está resolvida contra o código: schema em `src/db/migrations/001_bootstrap.sql` e
> `src/db/components/`, regras em `src/apps/api/` e `src/shared/`. Se uma entrada e o código
> divergirem, o código prevalece e a entrada corrige-se.

## Convenção PT-PT vs English

O projeto é bilingue por design - domínio jurídico/contabilístico em **PT-PT** (utilizadores),
implementação em **English** (código).

**Em English** (sempre): code identifiers, schema/table/column names, enum values,
function/type/method names, **URLs/routes** (panel e API - incluindo routes do portal para
utilizadores finais). Os termos técnicos seguem o standard accounting/dev:

- `bank_reconciliation` (não `bank_conciliation`) - "reconciliation" é o termo English correto.
- `unit`, `manager`, `charge`, `settlement`, `ledger` - todos corretos em English.
- Routes: `/reconciliation`, `/receipts`, `/charges`, `/assemblies`, `/statement` - sempre English,
  sem exceção.

**Em PT-PT** (sempre): prosa de docs, UI labels, comentários que descrevem domínio, filenames de
docs PT (`06-fluxo-reconciliacao.md`).

Quando os termos não coincidem entre as duas línguas, cada definição neste documento lista os mapas:

- "fração" (PT) ↔ `unit` (en)
- "conciliação" (PT) ↔ `reconciliation` (en)
- "condómino" (PT) ↔ `occupant` ligado por `unit_occupant.relationship_type='owner'` (en)
- "administrador" (PT) ↔ `manager` (en)
- "recibo" (PT) ↔ `receipt` (en)
- "cobrança" (PT) ↔ `charge` (en)
- "extrato" (PT) ↔ `statement` (en)
- "assembleia" (PT) ↔ `assembly` (en)
- "ponto da ordem do dia" (PT) ↔ `assembly_agenda_item` (en)
- "orçamento" (PT) ↔ `budget` (en)
- "anexo" (PT) ↔ `attachment` (en)
- "fornecedor" (PT) ↔ `supplier` (en)
- "ocorrência" (PT) ↔ `ticket` (en)
- "vistoria" (PT) ↔ `inspection` (en)
- "plano de pagamento" (PT) ↔ `payment_plan` (en)

## Language - Financeiro core

**Charge:** Evento financeiro registado; **ponto de entrada para o `ledger`**. Tem `nature`
(`debit`/`credit`), `kind` (`receivable`/`payable`) e `charge_type` que classifica a origem.
`charge_type` é texto livre (sem CHECK); valores que o código reconhece: `quota`,
`extraordinary_quota`, `refacturation`, `expense`, `supplier_service`, `recurring_fee`, `interest`,
`credit_balance`, `credit_adjustment`, `opening_balance_debit`, `openingBalance`, `unclassified`.
Pode ter fração e/ou fornecedor associado, ou nenhum (ex.: juro bancário, comissão). Uma charge
`debit` emite as suas linhas de `ledger` ao ser criada (trigger `finance.fn_charge_ai`); os
pagamentos entram por **Settlement**. Slogan: _nada lança diretamente no ledger - tudo passa por uma
Charge._ As duas exceções são o saldo de abertura de uma conta bancária e a transferência entre
bolsas (ver **FCR**), em que o próprio handler escreve as partidas dobradas. PT na UI: "cobrança"
(receivable) e "despesa" (payable). _Avoid_: fatura, transaction, claim, debt; "cobrança" em
identificadores de código (em código é sempre `charge`).

**Entity code:** Pattern transversal para identificadores humanos. Cada entidade que adota o pattern
recebe um código `<prefix><N dígitos base-36 zero-padded>`: prefixo de uma letra
(`D`/`R`/`P`/`T`/`I`) + alfabeto `0-9A-Z` em N posições. Per-condomínio (escopo de tenant),
contínuo, nunca reseta, imutável após criação. Atribuído por trigger `BEFORE INSERT` com contador
atómico por condomínio (counter table). A largura é fixa por prefixo e não cresce sozinha. Ver
[ADR 0023](docs/adr/0023-entity-code-base36.md) para o pattern completo, a lista de prefixos
reservados, a capacidade por largura e o mecanismo de geração.

**Charge code:** Aplicação do **Entity code** a `finance.charge`. Formato `<prefix>` + dígitos
base-36 zero-padded, com largura por prefixo:

- **`D`** + 4 dígitos para **payable** (despesas): `D0001`, `D0002`, ..., `D000Z`, `D0010`, ...,
  `DZZZZ`.
- **`R`** + 5 dígitos para **receivable** (quotas, refaturações): `R00001`, `R00002`, ..., `RZZZZZ`.

Sequências **independentes** por (`condomínio`, `prefix`) - `D0023` e `R00023` coexistem no mesmo
condomínio sem conflito. Contínua (não reseta anualmente). Atribuída atomicamente no momento da
criação pelo trigger `finance.fn_charge_assign_code`, com contador em
`finance.charge_code_counter (condominium_id, prefix, last_number)`. Imutável depois (mantém-se em
charges canceladas - sem reciclagem).

Existe como **referência humana inequívoca** em qualquer momento:

- Pre-payment: admin diz ao condómino "regulariza R00023" ou ao fornecedor "fatura D0045".
- Conciliação: condómino escreve `R00023` no descritivo do MB/transferência → settlement fica
  trivial de fazer.
- Distinto do **recibo** (`YYYY/NNNNN`): recibo só nasce post-payment via conciliação; o code cobre
  o gap pre-payment.

Capacidade por condomínio: `D` `36^4 - 1 = 1.679.615`; `R` `36^5 - 1 = 60.466.175`. Schema:
`finance.charge.code` (`varchar(10)`; a coluna é nullable mas o trigger preenche-a em todos os
INSERT; CHECK `^(D[0-9A-Z]{4}|R[0-9A-Z]{5})$`). PT: "código da charge", "código da despesa" ou
"código da receita". _Avoid_: número, ID público.

**Pathology code:** Aplicação do **Entity code** a `core.pathology`. Formato `P` + 3 dígitos base-36
zero-padded: `P001`, `P002`, ..., `P009`, `P00A`, ..., `P00Z`, `P010`, ..., `PZZZ`. Capacidade:
46.655 patologias por condomínio (`36^3 - 1`). O CHECK (`^P[0-9A-Z]{3,}$`) aceita códigos mais
largos, mas a largura não cresce sozinha (ver ADR 0023). Per-condomínio, nunca reseta, imutável.
Atribuído na criação pelo trigger `core.fn_pathology_assign_code` - mesmo enquanto `status='draft'`,
o code já fica reservado.

**Pathology category:** Enum fixo de tipos técnicos de patologia da construção. Valores: `crack`
(fissura), `infiltration` (infiltração), `humidity` (humidade ascendente/condensação),
`efflorescence` (eflorescência/salitre), `detachment` (descolamento de azulejo/reboco/pintura),
`corrosion` (oxidação de armadura/metal), `mould` (fungos/bolor), `structural` (deformação/
patologia estrutural), `other` (catch-all).

**Sem campo `location` dedicado em pathology**: a localização física (fachada norte, junto à janela
X) descreve-se na própria `description` da patologia. Fotos servem como evidência visual. Não
confundir com **Ticket**, que tem coluna `location`.

**Sem campo `severity`/`priority` em pathology**: a ordenação na listagem é por status + data. Admin
avalia urgência caso-a-caso pela descrição e fotos. Diferente de **Ticket**, que tem `priority` enum
porque o workflow exige triagem rápida.

**Pathology registo só por admin**: patologia é registo técnico top-down. Condóminos reportam via
**Ticket** - se admin avaliar e confirmar carácter patológico, abre patologia separada e liga-lhe a
ocorrência (`core.ticket.pathology_id`). No portal, as patologias são só de consulta. Esta separação
evita ruído na listagem de patologias e mantém papéis distintos:

- Ticket = pedido de intervenção (bottom-up, qualquer um reporta).
- Pathology = registo técnico de estado físico (top-down, só admin regista).

**Pathology sem FKs para ticket, supplier ou charge**: `core.pathology` não aponta para nenhuma
dessas tabelas. A única ligação nativa é do lado da ocorrência: `core.ticket.pathology_id`
(opcional, `ON DELETE SET NULL`). Empreiteiro contratado, custo e referências de fatura
documentam-se em campos textuais (`description`, `resolution_notes`).

**Pathology - campos**:

- `title varchar(255) NOT NULL`, `description text` (inclui localização física, dimensões).
- `category` (ver Pathology category acima).
- `status` (ver lifecycle em **Pathology**, secção Operações e manutenção). CHECK constraints:
  `dismissed_reason` e `dismissed_at` obrigatórios quando `status='dismissed'`; `resolved_at`
  obrigatório quando `status='resolved'`.
- `affects_common_area boolean NOT NULL DEFAULT false`.
- `resolution_notes text` (preenchido quando `resolved` - o que foi feito).
- `detected_at date NOT NULL DEFAULT CURRENT_DATE`, `resolved_at date`, `dismissed_at date`. **Date,
  não timestamp** - horas não importam para patologias. A API preenche `resolved_at` /
  `dismissed_at` com a data do dia ao entrar no estado e limpa-os ao sair.
- Fotos via `core.attachment` polimórfico (`entity_type='pathology'`).
- N:N a units via `core.pathology_unit (pathology_id, unit_id)`, PK composta.

**Payment method (da charge):** Como o pagamento desta charge é executado no banco: `manual`
(default - exige ação do administrador: transferência, MB), `direct_debit` (autorizado por DD
bancário) ou `auto_transfer` (standing order). **Snapshot** copiado do `recurring_template` no
momento da geração - preserva o método vigente quando a charge foi criada, mesmo se o template mudar
depois. Charges manuais (não-recurring) herdam o default `manual` mas admin pode alterar. Aplica-se
a ambos `kind` (payable+receivable) embora a UI só exponha em despesas. Schema:
`finance.charge.payment_method`. PT: "método de pagamento". _Avoid_: payment type, billing method.

**Scope (da charge):** Âmbito de uma charge - `unit` (imputada a uma fração específica, aparece na
vista dessa fração) ou `condominium` (geral do edifício, sem fração associada - ex.: comissão
bancária, despesa geral). Determinado automaticamente: se `unit_id` está presente → `scope='unit'`;
senão → `scope='condominium'`. Afeta a filtragem na UI e o saldo da fração (`v_unit_balance` só
conta `scope='unit'`). PT: "âmbito". _Avoid_: type, level, category.

**Settlement:** Linha atómica que liga duas pontas financeiras - `bank_tx ↔ charge` ou
`charge ↔ charge` - registando que uma saldou (parcial ou totalmente) a outra. Não se edita nem se
apaga: anula-se por _reversal_ (`status` `active` → `reversed`), que emite as linhas de ledger
inversas. Cada pagamento ou compensação produz um ou mais settlements. Tipos (`settlement_type`):
`bank_reconciliation`, `charge_offset`, `bank_deposit_credit` (ver _Relationships_). Schema:
`finance.settlement`. _Avoid_: match, link, reconciliation entry, alocação.

**Imputação:** Algoritmo (`planAllocation`, em `$api/modules/admin/allocation/plan.ts`) que
distribui o valor de um `bank_tx` por charges em aberto de uma fração ou fornecedor, seguindo a
ordem legal de prioridade (Art. 784.º CC). Fração: juros → vencidas/parciais → quotas correntes →
refaturações → outras. Fornecedor: vencidas/parciais → outras. **Produz N settlements** num só ato.
Na fração, o excedente cria uma `charge` crédito (`charge_type='credit_balance'`) ligada ao
movimento por um settlement `bank_deposit_credit`; no fornecedor, o excedente fica por imputar. Ver
[fluxo de imputação](docs/flows/07-fluxo-imputacao.md). _Avoid_: allocate, alocação, distribute,
FIFO matching.

**Offset:** `Settlement` automático que liga uma `charge` crédito a uma `charge` débito da mesma
fração (só receivables). Criado em TypeScript por `applyAutoOffset`
(`$api/modules/admin/charge/auto_offset.ts`), chamado na criação manual de charges, na geração de
quotas, na geração recorrente e no cancelamento de uma charge (para as que ela deixou livres); o
trigger `finance.fn_charge_ai` só emite ledger. Identificado por `settlement_type='charge_offset'`.
A ordem de consumo é própria, distinta da da imputação (ver
[ADR 0035](docs/adr/0035-auto-offset-ordering-distinct-from-allocation.md)). _Avoid_: compensação,
auto-compensation.

**Conciliação** (PT-PT) ↔ **Reconciliation** (en): Ato de criar `settlement(s)` para um `bank_tx`
pendente - pode ser manual (utilizador escolhe a charge) ou via _imputação_ (algoritmo). A página
`/admin/c/:cid/reconciliation` abre no separador "Em aberto": os bank_tx por conciliar, parciais e
revertidos. A **data de corte** (`core.condominium.reconciled_through_date`) diz até que dia a
conciliação está feita; é a referência de "vencido" no saldo da fração e nos lembretes de cobrança.
Ver [fluxo de conciliação](docs/flows/06-fluxo-reconciliacao.md).

- **PT-PT** (prosa, UI labels, docs PT, comentários PT): usar **conciliação**. Em PT-PT,
  "reconciliação" é castelhanismo - evitar.
- **English** (code, schema, enum values, routes): usar **reconciliation**. O
  `settlement_type='bank_reconciliation'` está correto. _Avoid_: match, settle. Em PT-PT
  especificamente: **reconciliação**.

**Lembrete de cobrança** ↔ `billing_reminder` (en): Email enviado a uma fração com dívida em atraso
para reclamar pagamento. Segue o pattern do `insurance_reminder`. Gatilho: pelo menos 1 charge
receivable de `nature='debit'` por saldar (qualquer `charge_type`: quota, quota extraordinária,
refaturação, saldo inicial) com `reconciled_through_date - due_date > 30 dias`. O email lista todos
os débitos receivable vencidos até à data de corte da conciliação (não só quotas; os futuros ficam
de fora). Recipients: ocupantes ativos com `relationship_type IN ('owner', 'resident')` - tenants
excluídos (Art. 1424.º CC). Cooldown 14 dias desde o último envio com pelo menos 1 ocupante `sent`.
Bloqueado quando a conciliação está a mais de 3 dias de distância (ou NULL). A listagem filtra por
blocos de atraso (+1/+30/+60/+90 dias); o bloco +1 baixa o gatilho para 1 dia. Cada envio fica
registado em `core.billing_reminder`. Ver [ADR 0028](docs/adr/0028-billing-reminder.md). _Avoid_:
cobrança automática, dunning, interpelação.

**Plano de pagamento** ↔ `payment_plan` (en): Acordo de regularização de dívida de uma fração,
registado como **anotação informativa** - descreve como se vai dar (`notes`) + `end_date` opcional.
**NÃO gera charges nem toca no `ledger`** (a dívida real vem sempre das charges). Estados:
`active -> completed | broken | cancelled` (transições manuais; `status` é a verdade, `end_date` não
expira nada). Máximo 1 `active` por fração; terminais ficam como histórico. **Tradução vinculativa
dos estados na UI**: `active` = "ativo", `completed` = "cumprido", **`broken` = "em
incumprimento"**, `cancelled` = "cancelado". Em PT-PT um acordo que falha entra em
**incumprimento**; "quebrado" é tradução literal de _broken_ e não se usa. O valor do enum mantém-se
`broken` (código em English). Na página de lembretes (`billing_reminder`): badge "Em plano", filtro
por presença, e o **bulk de envio salta** frações em plano (envio individual continua permitido e
manda a **variante de plano** do email: nota partilhada + data final + valores pendentes). O plano
tem duas notas: **nota partilhada** (`notes`, visível ao condómino no email) e **nota interna**
(`internal_notes`, só a administração); basta uma. Schema: `core.payment_plan`. Ver
[ADR 0039](docs/adr/0039-payment-plan.md). _Avoid_: acordo, parcelamento, installment plan,
moratória, **plano quebrado** (usar "plano em incumprimento").

**Ledger:** Subsistema contabilístico do condomínio. Compreende a tabela `finance.ledger` (linhas
atómicas em partidas dobradas; imutável - triggers rejeitam UPDATE, DELETE e TRUNCATE), o
`finance.chart_of_account` (códigos de conta, global + custom por condomínio) e a invariante **Σ
débitos = Σ créditos** para cada operação. É o livro razão - fonte de verdade contabilística do
condomínio. Views: `finance.v_bank_balance` deriva do ledger; `finance.v_unit_balance`,
`finance.balance_unit` e `finance.balance_supplier` agregam o valor em aberto das charges. _Avoid_:
livro contabilístico, accounting log, transaction log, journal.

**Account code:** Código de uma conta no `chart_of_account`, no padrão SNC (ex.: `2111` =
"Condóminos - Quotas Ordinárias"). Identifica a natureza contabilística de uma linha de Ledger.
Plano híbrido - contas globais (seed) + contas custom por condomínio. _Avoid_: account number,
ledger code.

**Partidas dobradas:** Princípio de que cada operação produz pelo menos 2 linhas no Ledger - uma a
débito + uma a crédito - com somas iguais. Invariante imutável do subsistema Ledger. _Avoid_:
double-entry (manter PT-PT em prosa).

**Bank account:** Bolsa de dinheiro do condomínio - **conta bancária** real (`kind='bank'`,
alimentada por importação de extrato XLSX) ou **caixa** de numerário (`kind='cash'`, inserção
manual). Tem `opening_balance` com split ordinário/FCR (`opening_balance_ordinary_cents` +
`opening_balance_fcr_cents`), e o saldo atual = opening + Σ `bank_transaction`. Em prosa/UI usar
"conta bancária" ou "caixa" consoante o `kind`; em código fica `bankAccount` como umbrella. Schema:
`finance.bank_account`. _Avoid_: account, conta corrente.

**Bank transaction:** Movimento individual (entrada ou saída) de um `bank_account`. **Dado bruto** -
importado de um extrato ou inserido manualmente. Por si só **não gera Ledger**; só dispara linhas de
Ledger quando um Settlement o liga a uma Charge. Status: `unreconciled` → `partial` → `reconciled`
(+ `ignored` para movimentos postos de parte, `reversed` para estornos). Schema:
`finance.bank_transaction`. _Avoid_: payment, movement, transação bancária.

**Bank import batch:** Lote de importação de um extrato XLSX para um `bank_account` (preview +
commit). Cada batch agrupa as transações importadas de uma vez e guarda `rows_total`,
`rows_imported` e `rows_skipped`. A deduplicação faz-se pelo `import_hash` de cada
`bank_transaction`, único por conta bancária - se o hash já existe, a linha é ignorada
(idempotente). Schema: `finance.bank_import_batch`. PT: "lote de importação". _Avoid_: upload, file
import.

**Bank reversal:** Anulação de um `bank_transaction` conciliado (estorno bancário, duplicado
identificado). Cascata em TypeScript: reverte todos os settlements ativos ligados à transação (o que
restaura o `open_amount` das charges afetadas e emite linhas de Ledger inversas) e anula os recibos
emitidos contra ela. O bank_tx muda para `status='reversed'`, com `reversal_reason` obrigatório. PT:
"estorno". _Avoid_: refund, undo, rollback, cancelamento.

**Competence period:** Mês a que a charge pertence contabilisticamente (regime de
competência/accrual). Pode diferir do mês de criação ou pagamento - ex.: despesa de Dezembro paga em
Janeiro. Guardado como `date` no primeiro dia do mês (`YYYY-MM-01`); a API expõe `YYYY-MM`. Usado na
janela de ajuste (permite retroativos ao ano findo) e no reporting por ano. PT: "período de
competência". _Avoid_: billing period, month, payment date.

**Recurring template:** Modelo de charge automática com periodicidade configurável (`interval_type`:
`monthly`, `bimonthly`, `quarterly`, `semiannual`, `annual`). Enquanto ativo, a geração
(`runRecurringGeneration`, em TypeScript, pedida por `POST .../recurring_templates/generate`) cria
as charges em falta até à data pedida, respeitando `end_date`; cada execução fica em
`core.recurring_generation_run`. Associado opcionalmente a fornecedor (`supplier_id`) e a fração
(`unit_id`). Schema: `core.recurring_template`. PT: "modelo recorrente". _Avoid_: subscription,
auto-charge, standing order.

**Tesouraria:** Conceito agregado - saldo das duas bolsas do condomínio no ledger: **bolsa
ordinária** (account code `121`) e **bolsa FCR** (`122`). Não é entidade no schema; é a view
`finance.v_bank_balance` (`ordinary_cents`, `fcr_cents`, `total_cents`) e um termo de relatório. Não
é a soma dos saldos dos `bank_account`: um movimento por conciliar conta no saldo da conta bancária
mas só entra no ledger quando um settlement o liga a uma charge. _Avoid_: cash position, treasury
balance.

## Language - Fornecedores e contratos

**Supplier:** Fornecedor de serviços ou obras ao condomínio (empresa de limpeza, manutenção de
elevadores, etc.). Tem NIF, contacto, uma `account_id` que aponta para a conta de despesa default no
`chart_of_account`, e `match_keywords` (ver **Match keywords**). Schema: `core.supplier`. PT:
"fornecedor". _Avoid_: vendor, provider, prestador, empresa.

**Supplier contract:** Não modelado como entidade - não existe tabela de contratos.
`core.recurring_template.contract_id` e `finance.charge.contract_id` são colunas de texto sem tabela
nem FK por trás, e nenhuma validação as usa. A periodicidade e o montante de um serviço recorrente
vivem no **Recurring template**. PT: "contrato de fornecedor". _Avoid_: agreement, SLA, service
contract.

## Language - Pessoas e estrutura

**Condomínio:** Edifício ou conjunto de edifícios sujeitos ao regime de propriedade horizontal (Cap.
VI, Tít. II, Livro III do CC). É a unidade multi-tenant do sistema - todas as queries de domínio
filtram por `condominium_id`. Schema: `core.condominium`. _Avoid_: building, prédio, tenant.

**Fração:** Cada parte autónoma do condomínio (apartamento, garagem, loja). Tem `permillage` (peso
para rateio das quotas), `designation` (nome amigável: "Fração A", "Garagem 1") e zero-ou-mais
`unit_occupant` ligando-a a ocupantes ao longo do tempo. Schema: `core.unit`. **Regra de tradução:**
PT-PT/UI/docs/comentários usam **"fração"**; código/schema/URLs usam **`unit`**. _Avoid_: apartment,
apartamento, fracção (grafia anterior ao Acordo Ortográfico).

**Condómino:** **Proprietário** de pelo menos uma fração. Subconjunto de `Ocupante`: representado
como `occupant` ligado via `unit_occupant` com `relationship_type='owner'`. Tem direitos legais
distintos - voto em assembleia, receção de convocatórias e recibos, sujeito passivo das quotas (Art.
1424.º+ CC). _Avoid_: owner em prosa PT, proprietário (legal mas ambíguo).

**Ocupante:** Qualquer pessoa ligada a uma fração via `unit_occupant` - inclui **condóminos**
(`relationship_type='owner'`), **inquilinos** (`relationship_type='tenant'`) e **residentes**
(`relationship_type='resident'`). Termo umbrella usado quando a operação não distingue. **A relação
pessoa↔fração é per-ligação**: o mesmo Ocupante pode ser proprietário numa fração e inquilino noutra
do mesmo condomínio - não há "tipo global" do ocupante. Schema: `core.occupant`. _Avoid_: tenant em
prosa, resident, `occupant.type` (não existe: o tipo de relação vive em
`unit_occupant.relationship_type` - ver [ADR 0018](docs/adr/0018-occupant-type-removal.md)).

**Inquilino:** Ocupante com `relationship_type='tenant'` em pelo menos uma ligação. Sem direitos de
voto nem convocatórias por defeito; tipicamente paga a quota mas não é o sujeito jurídico dela. Não
recebe lembretes de cobrança nem recibos. Em prosa PT-PT. _Avoid_: renter, lessee.

**Administrador (do condomínio):** Pessoa que gere operacionalmente o condomínio (Art. 1435.º CC).
Modelado como **atribuição per-condomínio** - registo em `core.manager` (junction
`user_id × condominium_id`), não como `role` global no user. Sempre que vires "manager" no código, é
um Administrador. Um administrador pode ser:

- **Interno** - `user` com `core.manager` record E pelo menos um `unit_occupant` neste condomínio
  (condómino que também administra). Caso típico.
- **Externo** - `user` com `core.manager` record sem `unit_occupant` (administração profissional).
  Suportado pelo schema; a API não tem caminho para criar um: o toggle `isManager`
  (`PATCH .../users/:userId`) só promove quem já tem vinculação ao condomínio (proprietário de uma
  fração ou com registo `core.manager` anterior).

_Avoid_: admin em prosa PT, gestor.

**Super:** Role de utilizador com acesso global a todos os condomínios. Único valor não-nulo de
`user.role`. Distinto do **Administrador** (confinado aos seus condomínios via `core.manager`). URL:
`/v1/super/*` (gestão de condomínios e das suas frações). UI: página "Condomínios" do grupo
"Sistema" do menu. _Avoid_: root, superadmin, master.

**User:** Identidade de autenticação. Tem `role` que é `'super'` ou `null` - não há mais valores. As
outras "qualidades" do utilizador derivam-se das tabelas de relação:

- É administrador deste condomínio? → `core.manager` record ativo para `(user_id, cid)`.
- É proprietário/inquilino/residente de uma fração? → `core.unit_occupant.relationship_type` em
  `'owner'` / `'tenant'` / `'resident'`.

Um User pode acumular qualquer combinação destes papéis (ex.: super + occupant; admin de A +
occupant em B; só admin externo). Schema: `core.user`. _Avoid_: account, identity, role-baseado em
enum (ver [ADR 0002](docs/adr/0002-user-role-consolidation.md)).

**User ativo** (`core.user.is_active = true`): pode autenticar-se e tem sessão válida em runtime.
Quando `false`, o login é rejeitado **e** as sessões em curso deixam de validar na próxima request
(filtro em `loadUserMembership`). Estado recuperável - reativar repõe o acesso sem perda de
histórico. É uma operação global de identidade, do `super`; a API não expõe endpoint para a alterar
(ver [ADR 0020](docs/adr/0020-session-idle-ttl-and-user-active-flag.md)). Distinguir de
**soft-delete** (`core.user.deleted_at IS NOT NULL`): o user passa a ser considerado inexistente
para efeitos de `membership`. Remover um utilizador de um condomínio (`DELETE .../users/:userId`)
não toca em `core.user`: marca `deleted_at` nas relações desse condomínio (`manager`, `occupant`,
`unit_occupant`). _Não usar_ `is_active` para suspender condóminos por falta de pagamento - o
condómino mantém o acesso enquanto for occupant.

**Manager ativo num condomínio** (`core.manager` com `deleted_at IS NULL` e `is_active = true`): a
relação `user × condo` está em vigor. Sem ela, o user perde **apenas** o acesso admin a esse
condomínio - mantém acesso ao portal se for occupant noutro (ou no mesmo) condo. O toggle
`isManager` (`PATCH /v1/admin/condominiums/:cid/users/:userId`) retira o acesso com soft-delete do
registo e repõe-no restaurando-o; pertence ao `super` ou a um administrador do mesmo condomínio, e
recusa remover o último administrador ativo (`409 LAST_MANAGER`).

**Vinculação:** O conjunto de relações (ativas e históricas) entre um `User` e um `Condomínio`.
Concretiza-se em `core.manager` (administrador) + `core.occupant` (pessoa no condomínio) +
`core.unit_occupant` (ligação à fração). Distingue-se entre **vinculação ativa** (registos sem
`deletedAt`, conferem acesso) e **vinculação histórica** (registos soft-deleted, mantidos para audit
e para restaurar o toggle de administrador). Code: `loadUserMembership(...)` em
`$api/libs/membership/mod.ts` devolve um snapshot único; `inCondo(cid)` foca-se num condomínio
específico. Single source of truth: a autenticação (`apiAuth`), `/v1/auth/me`, o acesso ao portal e
a gestão de utilizadores respondem todos a partir deste snapshot. _Avoid_: relationship, ligação
(genérico), membership em prosa PT (manter "vinculação").

## Language - Eventos e operações

**Assembleia:** Reunião dos condóminos (Art. 1430.º+ CC). Tem `type` (`ordinary` anual ou
`extraordinary` pontual) e `status`: ciclo `draft` → `scheduled` → `held`, retificação `scheduled` →
`draft`, e `cancelled` a partir de qualquer estado vivo (terminal). Tem uma **ordem do dia**: lista
de **pontos** (`assembly_agenda_item`), montada enquanto em `draft`. Depois de convocada
(`scheduled`), cada ponto é votado e produz a sua **deliberação** (resultado: `approved` +
`votes_in_favor/against/abstain` + linhas em `assembly_vote`). Ao passar a `held`, os pontos
`approve_budget` aprovados aprovam o orçamento que referem (trigger
`core.fn_assembly_held_approve_budgets`); é o único efeito automático de uma deliberação. Tem
**convocation_round** (`first`/`second` - Art. 1432.º nº 1), **presidente** e **secretário**
(assinam a acta) e **data de assinatura** (`minutes_signed_at`); os três preenchem-se em conjunto
(CHECK). Schema: `core.assembly`. _Avoid_: meeting, general assembly em prosa PT.

**Ordem do dia / Deliberação:** Distinção vinculativa (ver
[ADR 0033](docs/adr/0033-assembly-agenda-item-vs-deliberation.md)). Um **ponto da ordem do dia**
(`assembly_agenda_item`) é um assunto a tratar - tem `subject`, `description`, `sequence` e
`item_type` (`approve_budget`/`accounts_approval`/`admin_election`/`approve_fcr_usage`/`info`/
`other`); um ponto `approve_budget` refere o orçamento em `ref_type='budget'` + `ref_id`. Enquanto
em `draft`, monta-se a ordem do dia (CRUD dos pontos). A **deliberação** é o _resultado_ de votar um
ponto (`approved` + `votes_*` + `assembly_vote`), registado depois de a assembleia ser convocada. UI
e acta: a secção chama-se sempre **"Ordem do dia"** (na acta, um bloco "Ponto N" por ponto); o termo
**"Deliberação"** só designa o resultado de cada ponto. Schema: `core.assembly_agenda_item`.
_Avoid_: "decisão"/`decision` para o ponto da ordem do dia (em código e prosa PT); "deliberação"
para o ponto antes de votado.

**Assembly attendee:** Registo de presença numa assembleia. 1 row por (assembleia × unit ×
`convocation_round`); `occupant_id` é o titular da fração. Quando um condómino se faz representar
por procurador (Art. 1431.º nº 5), a row da unit representada tem `is_proxy=true` e identifica o
procurador (ver **Procuração**). A permilagem aplica-se à `unit` (snapshot em
`permillage_at_meeting`). Conjunto de attendees + permilagens determina se há **quórum** (Art.
1432.º). Schema: `core.assembly_attendee`. PT: "presença" ou "presente". _Avoid_: attendance,
participant.

**Assembly vote:** Voto individual de uma fração sobre um ponto da ordem do dia
(`assembly_agenda_item`). 1 row por (ponto × unit) com `vote` (`favor`/`against`/`abstain`) +
`permillage_applied` (snapshot, imutável). Permite à acta listar **quem** votou como, requisito do
Art. 1433.º (direito de recurso de ausentes / votantes contra no prazo de 60 dias). O trigger
`core.fn_assembly_vote_aggregate` mantém os totais em
`assembly_agenda_item.votes_in_favor/against/abstain` em sync. Schema: `core.assembly_vote`.
_Avoid_: ballot, individual vote.

**Quórum:** Permilagem total dos presentes (ou representados via procuração) numa assembleia. 1ª
convocatória exige **maioria (>50%)** da permilagem total do edifício; 2ª convocatória (30 min
depois) aceita qualquer permilagem (Art. 1432.º nº 1). Calculado em TypeScript por
`calculateAssemblyQuorum()` (`$api/libs/assembly/quorum_majority.ts`). PT: "quórum". _Avoid_: quorum
(sem acento em prosa PT).

**Procuração (assembleia):** Delegação de poderes de um condómino noutra pessoa para uma assembleia
específica (Art. 1431.º nº 5). Registada como linha em `core.assembly_attendee` com `is_proxy=true`:
`occupant_id` aponta para o condómino representado, e quem atua fica em `proxy_holder_occupant_id`
(ocupante registado) ou em `proxy_holder_external_name` (pessoa de fora do condomínio) - exatamente
um dos dois. O procurador pode também estar presente em causa própria (linha separada). PT:
"procuração" ou "representação". _Avoid_: proxy em prosa PT.

**Budget:** Orçamento anual aprovado em assembleia ordinária. Lista as despesas esperadas por
rubrica (`budget_line`: `account_id` → `chart_of_account` + `annual_amount`). Depois de `approved`,
as quotas de cada fração geram-se por ação explícita do administrador
(`POST .../budgets/:budgetId/generate_quotas` → `runQuotaGeneration`, em TypeScript): o FCR soma-se
ao total anual (`fcr_percentage`) antes do rateio por permillage, e a geração é incremental até à
data pedida (uma quota por mês; repetir só cria o que falta). Cada execução fica em
`core.quota_generation_run`. State machine: `draft` → `approved` (só via assembleia - ponto
`approve_budget` aprovado numa assembleia que passa a `held`); `draft` ⇄ `not_approved` (marcação
manual de proposta preterida, reversível e escondida por defeito na listagem). Schema:
`core.budget`. _Avoid_: orçamento (manter "budget" em código; "orçamento" é OK em prosa PT).

**Budget suplementar:** Orçamento adicional aprovado em assembleia extraordinária para despesa
imprevista ou obra específica. Ligado ao budget principal via `parent_budget_id` (obrigatório). Gera
quotas extraordinárias (`charge_type='extraordinary_quota'`) em N prestações (`installments`) a
partir de um mês à escolha (`first_competence_period`), sem substituir nem fechar o budget anual.
Distingue-se do budget principal por `type='suplementar'`. _Avoid_: extra budget, additional budget,
rectificação.

**Quota:** Contribuição devida por uma fração ao condomínio. **Não é entidade separada** - é uma
`Charge` com `charge_type='quota'` (ordinária, mensal, gerada do budget principal) ou
`'extraordinary_quota'` (prestação de um budget suplementar, para obra/projeto específico). Cada
quota ordinária inclui componente ordinária + componente FCR. Ver
[fluxo de quotas](docs/flows/01-fluxo-quotas.md). _Avoid_: subscription, contribution, fee,
mensalidade.

**Refaturação:** Repercussão, numa ou mais frações, de parte ou da totalidade de uma despesa do
condomínio com componente de uso individual (ex.: luz da garagem partilhada). É uma `Charge` com
`charge_type='refacturation'`, `kind='receivable'`, ligada à charge da despesa original via
`source_type='refacturation'` + `source_id`, e com a mesma `account_id` (validado pelo trigger
`core.fn_refacturation_validate`). Mantém o trace para reporting. _Avoid_: rebill, charge-back,
repasse.

**FCR (Fundo Comum de Reserva):** Obrigação legal PT - mínimo 10% **sobre** as contribuições
ordinárias. Manifesta-se em quatro lados distintos do sistema:

1. **Contribuição FCR** - componente de cada quota ordinária
   (`X € ordinário + X × fcr% = quota total`, com `budget.fcr_percentage`). No ledger, só a quota
   ordinária reparte o crédito entre `721` (ordinário) e `723` (FCR).
2. **Bolsa FCR** - separação contabilística do saldo bancário (account code `122`, vs `121`
   ordinário). Cada recebimento de quota divide-se pelas duas bolsas na mesma proporção.
3. **Fundo FCR** - capital próprio (account code `581`), creditado pela parte FCR do saldo de
   abertura de uma conta bancária.
4. **Transferência entre bolsas** - reclassificação manual entre `121` e `122`
   (`finance.fcr_transfer`, `direction` `to_fcr`/`to_ordinary`), sem movimento bancário nem charge.
   Append-only: corrige-se com a transferência inversa.

Uma conta bancária dedicada ao FCR não é modelada: a separação é só contabilística, qualquer que
seja a conta onde o dinheiro está. Por lei, o FCR só pode ser usado para conservação/obras com
deliberação de assembleia; o sistema não impõe essa ligação (o ponto `approve_fcr_usage` só define a
maioria exigida, 2/3). Ver [fluxo FCR](docs/flows/05-fluxo-fcr.md). _Avoid_: reserve fund,
contingency fund.

**Recibo:** Documento oficial PT emitido pela administração para um pagamento conciliado: um recibo
por par (`bank_transaction` de entrada, fração), cobrindo os settlements ativos desse movimento para
essa fração (`bank_reconciliation` e `bank_deposit_credit`). Tem número sequencial por condomínio e
ano (`YYYY/NNNNN`), é **imutável** depois de emitido (exceto _void_ com motivo, que mantém o
histórico). Gera PDF, é enviado por email aos proprietários e residentes da fração com
`receive_receipt_emails=TRUE`. A emissão é explícita (individual ou em lote); um par pode ser
dispensado de recibo (`finance.receipt_skip`). Distingue-se de **Settlement**: Recibo é o documento
legal externo; Settlement é a entry contabilística interna. Schema: `finance.receipt`. _Avoid_:
payment receipt, transaction receipt.

**Fiscal year:** Ano contabilístico do condomínio. Schema: `finance.fiscal_year` (`year`,
`start_date`, `end_date`, `status`, `closed_at`, `closed_assembly_id`), com `status` em `open`
(default) / `closing` / `closed`. O único comportamento implementado é o bloqueio: com o ano
`closed`, o trigger `core.fn_block_closed_fiscal_year` rejeita INSERT/UPDATE em `finance.charge`
(pelo ano do `competence_period`) e em `finance.ledger` (pelo ano do `entry_date`). Não há API nem
ecrã para criar ou fechar anos. _Avoid_: accounting year, ano fiscal (manter "fiscal year" em
código).

**Janela de ajuste:** Período, depois de `31/12`, em que o ano findo ainda aceita lançamentos:
enquanto o `fiscal_year` desse ano não estiver `closed` (ou não existir), despesas e refaturações
que lhe pertencem podem ser registadas com `competence_period` desse ano. Depois de `closed`, o
trigger rejeita-as - sem retroativos. _Avoid_: adjustment period, grace period.

**Match keywords:** Palavras-chave configuradas por fração (`core.unit.match_keywords[]`) e por
fornecedor (`core.supplier.match_keywords[]`) para pré-seleção na conciliação. Ao listar os
movimentos (`?withSuggestions=1`), a API compara a descrição do `bank_tx` com estes termos: entradas
contra frações, saídas contra fornecedores; um único match dá uma sugestão, vários dão conflito. A
sugestão calcula-se em cada leitura e não se grava. Não tem efeito contabilístico - é UX de
sugestão. PT: "palavras-chave de correspondência". _Avoid_: tags, labels, auto-match rules.

## Language - Relatórios

Vistas agregadas só de leitura, no menu **Relatórios**. Nenhuma inventa dado: todas derivam do
`ledger` ou das `charge`. Rotas em English (`/reports/...`), labels em PT-PT.

**Movimentos do ano** (`/reports/movements`): extrato anual das duas bolsas do ledger - ordinária
(`121`) e FCR (`122`). Saldo inicial → movimentos → saldo final, com resumo mensal e por
contrapartida (a conta do outro lado do lançamento). **Uma linha por evento, não por linha de
ledger**: as pernas `121` e `122` do mesmo settlement (a quota parte-se em ordinário + FCR) colapsam
numa linha com duas colunas. É onde uma **transferência entre bolsas** se vê depois de feita.
_Avoid_: extrato bancário (o extrato do banco é o `bank_transaction`, outra coisa).

**Previsão de tesouraria** (`/reports/cashflow`): entrada vs saída de caixa a partir do saldo de
hoje, por data de vencimento. Duas fontes: charges em aberto e ocorrências ainda não geradas dos
`recurring_template` ativos (a fronteira é o `next_run_date` - o que já foi gerado é charge). O
vencido tem balde próprio e conta no saldo projetado. **Não conta**: quotas de orçamentos aprovados
ainda por gerar, e créditos de frações por usar (declarados à parte - abatem em cobranças futuras,
não são saída de caixa). _Avoid_: fluxo de caixa (reservar para o realizado), forecast.

**Execução por Ata** (`/reports/assemblies`): o que uma assembleia aprovou vs o que aconteceu.
Previsto = Σ `budget_line` do orçamento que o ponto da ordem do dia refere. Efetivado = despesas
imputadas a esse orçamento. Cobrado = quotas geradas por ele (`source_type='budget'`).

**Imputação (de despesa a orçamento):** etiqueta manual `finance.charge.budget_id` ganha à
inferência por rubrica + ano; rubrica partilhada por dois orçamentos do mesmo ano fica **ambígua** e
não conta em nenhum. Ver [ADR 0041](docs/adr/0041-assembly-budget-execution-imputation.md). PT:
"imputação"; distinta da **imputação de crédito** entre charges (settlement) - o contexto
desambigua.

## Language - Operações e manutenção

**Ticket:** Pedido de intervenção ou registo de ocorrência no condomínio (avaria de elevador,
infiltração, ruído). Tem `category` (`elevator`/`lighting`/`plumbing`/`hvac`/`common_area`/
`facade`/`parking`/`garden`/`security`/`cleaning`/`other`), `priority` (low/normal/high/urgent),
`status` (open → in_progress → resolved → closed) e código humano `T` + 3 dígitos (ver **Entity
code**). Pode estar ligado a uma fração (`unit_id`) ou ser geral, e a uma patologia
(`pathology_id`). Comentários internos (só admin, `ticket_comment.is_internal`) e externos (visíveis
ao reportante). Schema: `core.ticket`. PT: "ocorrência" ou "pedido". _Avoid_: issue, bug, request,
chamado.

**Ticket visibility:** Coluna `visibility` da `core.ticket`. 3 valores: `admin_only` (só
administração vê - default no admin), `admin_unit` (administração + ocupantes da fração afetada -
default no portal, exige `unit_id`), `public` (visível a todos os condóminos no portal - apropriado
para zona comum). Apenas admin altera. CHECK constraint força `unit_id NOT NULL` quando
`visibility=admin_unit`. PT-PT na UI: "Só administração", "Administração + fração", "Visível a todos
os condóminos".

**Inspection:** Vistoria regulatória obrigatória (extintores, deteção de incêndio, elevador, gás,
eletricidade, pára-raios, AVAC, piscina, antena, outra). Tem `category`, `last_done_date`,
`valid_until` (data de expiração), `notify_days_before` (alerta antecipado), fornecedor opcional
(`supplier_id`) e código humano `I` + 3 dígitos (ver **Entity code**). Pode estar ativa ou inativa
(`is_active`). Schema: `core.inspection`. PT: "vistoria" ou "inspeção". _Avoid_: check, audit,
review, certificação.

**Pathology:** Defeito ou anomalia física observada na construção do edifício (fissura, infiltração,
descolagem de azulejo, eflorescência, oxidação de armadura, humidade, fungos, deformação
estrutural). **State-oriented**: regista o estado físico observado, não um pedido de intervenção.
Frequentemente requer obra para reparação. Diferente de **Ticket**, que é action-oriented (workflow
de pedido open→resolved). Uma Pathology pode gerar zero, um ou vários Tickets ao longo do tempo
(várias tentativas de reparação) e pode reaparecer (recorrente).

- **Âmbito**: pode afetar partes comuns (`affects_common_area=true`) **e/ou** uma ou várias frações
  específicas (relação N:N via `pathology_unit`); pelo menos um dos dois é obrigatório. Não é
  mutually exclusive - uma infiltração no R/C pode afetar a parede da fachada (parte comum) **e** o
  interior das frações A e B simultaneamente.
- **Visibilidade**: `draft` é **sempre privado** (só admin vê). Qualquer outro status é público para
  todos os condóminos via portal. Não há toggle de visibilidade separado - derivado diretamente do
  status.
- **Lifecycle (8 estados)**:
  - `draft` (privado) - registo em redação (foto/causa por confirmar).
  - `identified` - patologia identificada; documentada e visível ao condomínio.
  - `awaiting_quotes` - admin a recolher cotações de empreiteiros.
  - `quote_approved` - cotação escolhida e aprovada.
  - `awaiting_repair_start` - obra contratada, à espera de arranque.
  - `in_repair` - obra em curso.
  - `resolved` - reparação concluída.
  - `dismissed` - encerrada sem reparação (cosmética, falsa anomalia, decisão de aceitar). Exige
    nota com a razão. Histórico distinto de `resolved` para relatórios.
- **Recorrência**: cada patologia é independente. Se uma patologia `resolved` reaparece fisicamente,
  abre-se uma **nova** patologia. Não há FK entre patologias, logo não existe ligação automática
  "esta é o retorno daquela" no histórico.
- **Transições**: admin pode mover entre qualquer um dos 8 status livremente (incluindo voltar a
  `draft`, que retira a patologia do portal até sair de draft outra vez). Sem state machine estrita.
  Distinção: "voltar atrás no status" é corrigir um registo errado; "reaparecer fisicamente após
  `resolved`/`dismissed`" abre uma nova patologia (ver recorrência acima).
- **Quote vs Budget**: os status `awaiting_quotes`/`quote_approved` referem-se a **cotações de
  empreiteiros** para a obra de uma patologia - distinto de `Budget` (orçamento anual do
  condomínio). PT-UI: "cotação" (não "orçamento") para a proposta comercial.

Schema: `core.pathology` + `core.pathology_unit`. Ver
[ADR 0024](docs/adr/0024-pathology-entity-design.md). PT: "patologia" (termo técnico de engenharia
civil e arquitetura). _Avoid_: defect, anomaly, damage, problem, issue.

**Insurance:** Apólice de seguro **por fração** - cobertura individual da habitação (multirriscos de
recheio/interior). Submetida pelo occupant via portal ou registada pelo admin. Tem seguradora
(`insurer`), número de apólice (`policy_number`), vigência (`valid_from`/`valid_to` ambas NOT NULL)
e capital segurado (`coverage_amount_cents`). O sistema nunca renova sozinho: renovar é um ato do
admin (presumido, sem prova) ou da fração (no portal, com o recibo), e cria uma nova apólice ligada
à anterior por `renewed_from_id` (ver
[ADR 0040](docs/adr/0040-insurance-renewal-lineage-freeze-delete.md)). Múltiplas apólices podem
coexistir na mesma fração (proprietário + inquilino podem ter coberturas independentes); o sistema
**não rastreia holder** - o status agregado da fração = "OK" se ≥1 apólice em `active` dentro de
vigência. Lifecycle: `pending_review` → `active` (aprovada) ou `rejected`; `active` → `superseded`
quando substituída pela vigência seguinte; o admin pode reabrir `active`/`rejected` para
`pending_review`. Evidência documental via `core.attachment` polimórfico
(`entity_type='insurance'`). **`evidence_source`** marca a origem dessa evidência: `NULL` sem
documento (renovação presumida), `'unit'` comprovativo submetido pela fração no portal, `'admin'`
documento que a fração entregou à administração fora do portal - terceiro estado com badge e filtro
próprios, aprovado sem confirmação da fração mas notificado a ela (ver
[ADR 0016](docs/adr/0016-insurance-evidence-from-source.md)). Flag `presumed_at` distingue
renovações criadas pelo admin sem evidência ainda - enquanto `attachment_count = 0` a fração conta
no KPI/filtro "presumidas sem comprovativo", mostra o badge "presumida há Nd" (agrava passados 30
dias), entra nos alvos do bulk com o trigger `renewal_evidence` e a renovação ainda pode ser
desfeita. **NÃO modela o seguro do edifício** contratado pelo condomínio para as partes comuns; ver
_Flagged ambiguities_. Schema: `core.insurance_policy`. PT: "seguro" ou "apólice". _Avoid_: policy
(ambíguo com access policy), coverage, garantia, holder (não modelado).

**Audiência (do seguro)** ↔ `InsuranceAudience` (en): Quem está a olhar para o estado de uma
apólice. Determina **em conjunto** a janela de "a expirar" (`ADMIN_NOTICE_DAYS` 30 vs
`OCCUPANT_NOTICE_DAYS` 15) e o gate de capabilities (`isAdmin` vs `isOwnUpload`). Duas audiências:
`adminAudience` e `occupantAudience(userId)`. Andam juntas de propósito: janela e gate nunca se
escolhem em separado, senão uma superfície classifica com a janela de uma audiência e mostra os
botões da outra. Code: `unitInsuranceView(policies, today, audience)` em
`$api/modules/admin/insurance/unit_view.ts`, o único caminho para "estado agregado desta fração"
([ADR 0017](docs/adr/0017-insurance-no-holder-aggregate-status.md)); usado pelo read-model do admin
e pelo portal. _Avoid_: viewer, role, perspetiva, contexto.

## Language - Infraestrutura

**Attachment:** Ficheiro associado a qualquer entidade do sistema. Tabela polimórfica unificada:
`entity_type` (`charge`/`ticket`/`inspection`/`assembly`/`insurance`/`document`/`pathology`) +
`entity_id` identificam o dono. Storage em S3 com path sharded, checksum SHA-256 (`file_sha256`), e
`storage_etag` para verificação. Schema: `core.attachment`. Ver
[ADR 0006](docs/adr/0006-polymorphic-attachment-table.md). PT: "anexo". _Avoid_: file, upload,
document (entidade distinta - ver abaixo).

**Document:** Ficheiro institucional do condomínio - ata de assembleia, regulamento interno,
apólice, contrato, planta. Tem `category` (allow-list
`minutes/regulation/contract/budget/insurance/plant/other`) e visibilidade controlada via
`is_public` (ver **Visibility**). Distinto de **Attachment**: Document é autónomo (entidade-mãe
partilhável) e tem zero-ou-mais Attachments via tabela polimórfica (`entity_type='document'`).
Schema: `core.document`. PT: "documento". _Avoid_: file, attachment (entidade distinta), upload,
`doc_type` (o campo é `category`), `visible_to_owners` (o campo é `is_public`).

**Visibility:** Regra que decide o que o portal vê de um recurso partilhável. Em `core.document` é a
flag boolean `is_public`:

- `is_public=true` → recurso aparece no portal (read-only, em todas as queries de leitura e no serve
  dos seus anexos).
- `is_public=false` → recurso só visível ao admin.

Noutros recursos a regra é um conjunto de estados: assembleias e patologias são públicas em qualquer
`status` exceto `draft`; ocorrências têm três níveis (ver **Ticket visibility**). Aplicada em duas
camadas defensivas: (1) **scope** nos query builders partilhados com o admin (`scope: "public"`
força a regra na where-clause; ignora `?isPublic=false` que vaze do filtro do admin), (2)
`ownershipQuery` da factory de attachments - o portal injeta uma query com a mesma regra para que o
serve do anexo nunca chegue a tocar bytes de recursos privados (anti-IDOR). Ver
[ADR 0003](docs/adr/0003-portal-visibility-scope.md). PT: "visibilidade". _Avoid_: privacy,
exposure, public_flag.

**Actor:** Quem desencadeou uma operação que altera estado do sistema. Sempre um **User** - não há
actor "system" como entidade separada; operações sem user humano (scripts, jobs) registam `{}`.
Capturado como **ActorSnapshot** (JSONB) nos campos `created_by`/`updated_by`/`deleted_by` das
tabelas auditáveis e no `actor` de `audit.cdc_log` e `audit.email_log`. Forma canónica:
`{user_id, email, ip, user_agent, request_id}` - todos opcionais individualmente. `created_by` e
`updated_by` são por regra `NOT NULL DEFAULT '{}'`; algumas tabelas têm-nos nullable (`core.unit`,
`core.budget`, `core.occupant`, `core.supplier`, `finance.charge`, `finance.bank_transaction`), e aí
`NULL` lê-se como `{}`. `deleted_by` é nullable (só se preenche no soft-delete). As respostas da API
nunca expõem estes campos.

**Regra de cobertura (escala com lifecycle da tabela):**

| Lifecycle                                          | Colunas actor                               |
| -------------------------------------------------- | ------------------------------------------- |
| Append-only mas escrita pela API (generation runs) | `created_by` apenas                         |
| Mutável sem soft-delete                            | `created_by` + `updated_by`                 |
| Mutável + soft-delete (`deleted_at` existe)        | `created_by` + `updated_by` + `deleted_by`  |
| Lançamentos derivados (`finance.ledger`)           | nenhuma - o actor está no registo de origem |
| Views                                              | nenhuma                                     |
| Audit logs (`cdc_log`, `email_log`)                | usam `actor` field próprio                  |

`deleted_at` e `deleted_by` andam **sempre em par** - se uma tabela tem soft-delete, tem ambas.
Detalhe de regra de preenchimento, propagação e resolução do actor no audit em
[ADR 0011](docs/adr/0011-actor-snapshot-convention.md). _Avoid_: agent, principal, caller, user
(User é a entidade; Actor é o snapshot da User no momento da ação).

**Notification:** Comunicação enviada pelo sistema a ocupantes e utilizadores. O único canal é o
**email** (`sendEmail`, em `$api/libs/email/send.ts`); cada envio fica registado em
`audit.email_log` (`category`, `recipient`, `status` `sent`/`failed`, `error`, corpo HTML, nomes dos
anexos, `actor`), exceto a recuperação de palavra-passe. Lembretes e convocatórias têm ainda um
registo por envio com o estado de cada destinatário (`recipients[]`): `core.billing_reminder`,
`core.insurance_reminder`, `core.assembly_convocation`. Não existe tabela `notification` nem canais
SMS, carta ou in-app. PT: "notificação". _Avoid_: message, alert, aviso, comunicação.

**Audit log:** Registo de todas as mutações (CDC) nas tabelas dos schemas `core` e `finance` que têm
coluna `id`, escrito pelo trigger genérico `audit.fn_log_change`. Particionado por ano para
performance. Captura: `table_schema`/`table_name`/`row_id`, `action` (insert/update/delete), `diff`
(JSONB com os campos alterados, antes e depois), `snapshot` (a row completa) e `actor`
(ActorSnapshot - é onde ficam IP e user agent). Imutável - triggers bloqueiam UPDATE, DELETE,
TRUNCATE e INSERT direto na própria tabela. Schema: `audit.cdc_log`. Ver
[ADR 0004](docs/adr/0004-audit-cdc-trigger-driven.md). PT: "registo de auditoria". _Avoid_: history,
changelog, event log, activity log, `core.audit_log` (não existe).

**Portal:** Módulo para condóminos e ocupantes acederem à informação da sua fração. URL panel:
`/portal/c/:cid/u/:uid/...`. API: `/v1/portal/condominiums/:cid/...` (recursos do condomínio) e
`/v1/portal/condominiums/:cid/units/:unitId/...` (recursos da fração). Expõe em consulta: charges
(cobranças), receipts (recibos), statement (extrato de pagamentos), assemblies, budgets, documents,
inspections, pathologies. Permite à fração submeter, confirmar e renovar apólices de seguro, abrir e
comentar ocorrências, e editar o próprio perfil (contactos, receção de recibos por email). Não
permite ações financeiras - só consulta e download de PDFs. Acesso: qualquer ocupante com ligação
ativa à fração (proprietário, inquilino ou residente). PT: "portal do condómino". _Avoid_: tenant
portal, client area, self-service.

## Relationships

- Uma **Charge** débito emite linhas no `ledger` ao ser criada; cada **Settlement** que a salda
  emite as linhas do pagamento.
- Um **Settlement** liga `bank_tx ↔ Charge` (`bank_reconciliation`), `Charge ↔ Charge`
  (`charge_offset`), ou `bank_tx ↔ Charge` crédito nascida do excedente de um depósito
  (`bank_deposit_credit`).
- **Imputação** é o algoritmo; **Settlement** é o que ela produz.
- **Offset** é um sub-caso automático de **Settlement** (criado pela aplicação quando nasce uma
  charge, não pelo utilizador).
- **Supplier** → **Recurring template** → **Charge** (cadeia de geração das despesas recorrentes).
- **Budget** → quotas; **Budget suplementar** → quotas extraordinárias (geração pedida pelo
  administrador).
- Um **Recibo** documenta um `bank_tx` de entrada conciliado, por fração.
- Um **Ticket** pode apontar para uma **Pathology** (`ticket.pathology_id`).
- **Ticket**, **Inspection**, **Pathology**, **Insurance** são entidades operacionais independentes
  do fluxo financeiro.

## Flagged ambiguities

- **Rotas em English - sem exceção.** Todas as URLs do panel, do portal e da API ficam em English
  (`/reconciliation`, `/receipts`, `/charges`, `/statement`, `/assemblies`, `/budgets`). Em PT-PT,
  "reconciliação" é castelhanismo - usar "conciliação" em prosa/UI labels/docs PT. O nome do
  ficheiro `docs/flows/06-fluxo-reconciliacao.md` é a exceção: tem "reconciliacao".
- **"Allocate" / "alocação"** no código (endpoints `allocate_to_unit`/`allocate_to_supplier`, módulo
  `allocation/`, `planAllocation`) é o mesmo que **imputação**. Em prosa/comentários PT/UI usar
  "imputação".
- **"Match" / `match_status`** é estado de sugestão UX, não tem efeito contabilístico. A aplicação
  não escreve em `bank_transaction.match_status`, `match_unit_ids` nem `match_expense_ids`: as
  sugestões calculam-se na leitura (ver **Match keywords**). Não confundir com **conciliação** (que
  é o ato contabilístico).
- **Seguro do edifício (partes comuns) não modelado.** O sistema só rastreia seguros **per-fração**;
  uma apólice contratada pelo condomínio para as partes comuns não tem entidade própria.
- **Contrato de fornecedor não modelado.** Só existem as colunas `contract_id` sem tabela (ver
  **Supplier contract**).
- **Fiscal year sem gestão na aplicação.** A tabela e o trigger de bloqueio existem; não há API nem
  ecrã para abrir ou fechar anos (ver **Fiscal year**).
- **Conta bancária dedicada ao FCR não modelada.** A separação ordinário/FCR é só contabilística
  (ver **FCR**).
- **Notificações só por email.** Não há tabela `notification` nem outros canais (ver
  **Notification**).
