# ADR 0018 - Ocupante sem tipo global: a relação vive em `unit_occupant.relationship_type`

## Contexto

O [ADR 0002](./0002-user-role-consolidation.md) fixa `core.unit_occupant.relationship_type` como
fonte canónica para "esta pessoa é proprietária ou inquilina desta fração?". O modelo é por ligação:
a mesma pessoa pode ser proprietária da fração A e inquilina da fração B no mesmo condomínio - duas
ligações, dois `relationship_type`.

Um "tipo" guardado no próprio ocupante só poderia ser uma cache derivada (a "relação mais forte",
`owner > tenant > resident`) ou um valor escolhido à mão. Em ambos os casos:

- **apaga informação verdadeira**: Maria Silva, proprietária de A e inquilina de B, ficaria
  "proprietária" por elevação e desapareceria de um filtro por inquilinos;
- **cria duas representações na mesma página** (badge por ligação e tipo do ocupante), que divergem
  sem que se saiba em qual confiar;
- **engana os KPI**: contar ocupantes por tipo exclui quem também tem outra relação noutra fração.

## Decisão

**`core.occupant` não tem coluna de tipo.** Guarda dados da pessoa (nome, email, telefone, NIF), não
da sua relação com frações. Essa relação vive em `core.unit_occupant.relationship_type`, uma linha
por ligação.

- **Valores**: `owner`, `tenant`, `resident` (CHECK `unit_occupant_relationship_check`; enum
  `RELATIONSHIP_TYPES` em `$api/libs/enums.ts`). `resident` equipara-se a `tenant` nas regras de
  negócio; verificações exclusivas de proprietário (voto, por exemplo) exigem `owner`.
- **`person_type` não é isto**: `core.occupant.person_type` (`singular`/`collective`) é a natureza
  jurídica da pessoa, não a relação com uma fração.
- **API**: os schemas de criação e edição de ocupante não aceitam tipo, e a listagem de ocupantes
  não filtra por tipo. Quem precisa da relação lê `unit_occupant`.
- **Lista de ocupantes (Panel)**: o filtro `?filter=owner|tenant|resident` é **any-match** - entra o
  ocupante com pelo menos uma ligação ativa desse tipo, e a linha continua a mostrar todas as suas
  ligações, não só as do filtro.
- **KPI**: "Proprietários" e "Inquilinos / Residentes" contam **ligações ativas** por
  `relationship_type`; "Ocupantes" conta pessoas distintas.
- **Detalhe do ocupante**: uma chip por `relationship_type` ativo.
- **Ocupantes órfãos** (sem ligações ativas) não têm tipo: aparecem em "Sem fração associada", sem
  badge de relação, e só quando não há filtro.
- **Import XLSX**: a relação é uma coluna por linha de ligação ("Relação"); não há elevação nem tipo
  do ocupante.

## Consequências

- Fonte única para o tipo de relação, sem cache nem semântica ambígua.
- Com o filtro any-match, Maria Silva aparece em `?filter=owner` e em `?filter=tenant`. É
  deliberado, mas pode surpreender.
- A soma dos KPI por relação pode exceder o número de ocupantes.

## Alternativas rejeitadas

1. **Coluna de "tipo principal" escolhida à mão.** Duplica a fonte canónica; a primeira coisa a
   divergir é a UI face à verdade por ligação.
2. **Coluna computada ou view com a elevação.** A elevação é exatamente o que esconde informação
   útil: ser inquilina algures importa para saber quem se convoca, porquê e em nome de quem.
3. **Manter a coluna e ignorá-la.** O schema é documentação: um campo presente lê-se como "existe um
   conceito aqui".
4. **Página como lista de ligações** (uma linha por ligação). Resolve a surpresa do any-match, mas
   muda o modelo mental da página; não adotada.

## Sinais de alerta para code review

- Coluna `type`, `role` ou "tipo principal" em `core.occupant`, ou em qualquer entidade que já tem
  uma junction com tipos por ligação.
- Lógica de elevação (`owner > tenant > resident`) para resumir uma pessoa num único valor.
- Filtro ou KPI que conte ocupantes por um tipo único.

Como decidir nos casos vizinhos:

- A pergunta tem resposta por ligação? A junction é a fonte; não duplicar no cabeçalho.
- É preciso um resumo na UI? Agregar os `relationship_type` distintos e mostrar uma chip por valor.
- A elevação simplifica uma query? Provavelmente esconde uma decisão de negócio ("aqui mostro só a
  relação mais alta"); torná-la explícita no sítio onde se aplica.

## Referências

- [ADR 0002](./0002-user-role-consolidation.md) - papéis do User; este ADR aplica o mesmo princípio
  ao ocupante.
- [`$api/libs/enums.ts`](../../src/apps/api/libs/enums.ts) - `RELATIONSHIP_TYPES`.
- [`$api/libs/model/occupant.ts`](../../src/apps/api/libs/model/occupant.ts) - schemas sem tipo.
- [`$panel/controllers/occupants.ts`](../../src/apps/panel/controllers/occupants.ts) - filtro
  any-match; KPI em `templates/pages/occupants/list.vto`.
- [`$api/libs/unit_import/parser.ts`](../../src/apps/api/libs/unit_import/parser.ts) - relação por
  ligação no import.
- `CONTEXT.md` - entradas **Condómino**, **Ocupante**, **Inquilino**.
