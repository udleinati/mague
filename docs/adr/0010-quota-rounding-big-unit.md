# ADR 0010 - Distribuição de quotas por permilagem: a big unit absorve o diff de arredondamento

## Contexto

A geração de quotas distribui um total pelas frações do condomínio segundo a permilagem
(`core.unit.permillage`) de cada uma. Arredondar cada contribuição ao cêntimo produz uma soma que
pode diferir do total em alguns cêntimos.

Exemplo: 100,00 EUR (10000 cêntimos) por quatro frações com permilagens 250, 250, 250 e 251 (total
1001):

```
250/1001 × 10000 = 2497,50...  →  2498   (× 3 frações)
251/1001 × 10000 = 2507,49...  →  2507
                                  -----
                                  10001  ≠  10000
```

Sem correção, o que se cobra às frações deixa de coincidir com o valor aprovado no orçamento.

## Decisão

**A fração ativa com maior permilagem (a "big unit") absorve o diff.**

### Algoritmo

`distributeByPermillage(valor, alvo, units, totalPm, bigUnitId)`:

1. Para cada fração: `c_i = ROUND(valor × permillage_i / totalPm)`.
2. `diff = alvo - Σ c_i`, em que `alvo` é o total inteiro, em cêntimos, que a soma tem de dar.
3. `c_bigUnit += diff`.

Garante `Σ c_i = alvo`, exatamente. No exemplo acima, a fração de permilagem 251 fica com 2506.

A função é pura. Com `bigUnitId = null` o diff não é absorvido - a soma só fecha se o caller passar
a big unit.

### Inputs

`loadDistributionInputs` (`budget/_distribution_inputs.ts`) carrega tudo de uma vez: as frações
ativas e as suas permilagens, `totalPm`, a big unit (a fração ativa de maior permilagem) e o total
do orçamento (Σ `annual_amount` das rubricas não eliminadas).

**A geração (`runQuotaGeneration`) e a previsão (`computeQuotaPreview`) usam ambas este loader e a
mesma `distributeByPermillage`.** É o que garante que o valor previsto por fração é igual ao que vai
ser cobrado.

### O alvo, por tipo de orçamento

- **Orçamento principal** - `computeMonthlyWithFcr(totalAnual, fcr%)` devolve o valor mensal exato
  (`totalAnual × (100 + fcr) / 100 / 12`, usado no passo 1) e o mesmo valor arredondado (o `alvo`).
  O FCR entra no total **antes** da distribuição por permilagem. A distribuição calcula-se uma vez e
  aplica-se a todos os meses.
- **Orçamento suplementar** (obra em N prestações) - `computeInstallmentAmounts(total, fcr%, n)`
  devolve N inteiros cuja soma é exatamente `ROUND(total × (100 + fcr) / 100)`: as primeiras N-1
  prestações são iguais e a última absorve o resto. Cada prestação é depois distribuída por
  permilagem com a mesma regra da big unit.

Os alvos e as contribuições são sempre cêntimos inteiros.

### Split FCR dentro de cada quota

A repartição entre parte ordinária e parte FCR não passa por este algoritmo. Faz-se por charge, no
trigger que emite o ledger (`finance.fn_charge_ai`): arredonda-se uma parte e a outra obtém-se por
diferença, pelo que as duas somam sempre o valor da charge. `finance.fn_charge_fcr_split` segue o
mesmo princípio nos settlements.

### Outros cálculos de distribuição

- Peso por permilagem: reutilizar `distributeByPermillage`.
- Outro peso (área, consumo): função análoga com a mesma forma - distribuir, calcular o diff, o
  maior absorve.
- Um teste que acuse `Σ ≠ alvo` aponta para o caller, que não passou quem absorve o diff. Corrige-se
  aí, não no algoritmo.

## Consequências

- A soma das quotas de um período é exatamente o alvo desse período.
- O ajuste recai sobre a fração que mais paga, onde tem o menor peso relativo. Cada arredondamento
  erra no máximo meio cêntimo, por isso o diff é da ordem de N/2 cêntimos no pior caso (N = número
  de frações); na prática, 1 a 2 cêntimos.
- **O invariante do orçamento principal é mensal, não anual.** Doze vezes o valor mensal arredondado
  pode diferir alguns cêntimos do total anual com FCR. No suplementar, a soma das prestações é
  exata.
- **Empate na permilagem máxima**: a query ordena só por permilagem, sem critério de desempate. O
  total continua exato; a fração que absorve o diff é a que a base de dados devolver primeiro.

## Alternativas rejeitadas

1. **Distribuir o diff proporcionalmente por todas as frações.** Não fecha o problema (o diff do
   diff volta a aparecer) e nenhuma fração fica com uma regra clara para o seu cêntimo.
2. **Conta de ajustes ou suspense para o diff.** Cria lançamentos que não correspondem a nenhuma
   obrigação real de um condómino e uma pergunta recorrente sobre o saldo dessa conta.
3. **`numeric` em vez de cêntimos inteiros.** Todo o modelo financeiro usa cêntimos inteiros, e o
   arredondamento continua a existir quando se converte para duas casas decimais.
4. **Atribuir o diff aleatoriamente.** Resultados diferentes entre execuções e testes instáveis.
5. **Escolher quem absorve pelo valor e não pela permilagem.** Perde a relação direta "quem tem mais
   peso no rateio absorve o ajuste".

## Sinais de alerta para code review

- Rateio que arredonda fração a fração e não corrige a soma.
- Diff de arredondamento repartido por várias frações.
- Previsão de quotas calculada com inputs que não vêm de `loadDistributionInputs`.
- Valores monetários em `float` ou `numeric` num cálculo novo.

## Referências

- Algoritmo:
  [`quota_distribution.ts`](../../src/apps/api/modules/admin/budget/quota_distribution.ts), com
  testes em `budget/quota_distribution_test.ts`.
- Inputs e callers, na mesma pasta: `_distribution_inputs.ts`, `quota_generator.ts`,
  `quota_preview.ts`.
- Split FCR: [`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql);
  `test_sql/tests/0047_fcr_rounding_drift.sql`.
- [ADR 0001](./0001-financial-cascade-split.md) - a geração de quotas vive em TypeScript.
