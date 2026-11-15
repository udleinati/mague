# Mague

Plataforma open source para a gestão de condomínios em Portugal: contabilidade em partidas dobradas,
cobrança de quotas, conciliação bancária, assembleias, seguros, manutenção e um portal para os
condóminos.

> [!WARNING]
> **Projeto em beta (work in progress).** O Mague está em desenvolvimento ativo: pode ter erros,
> mudar sem aviso e quebrar a compatibilidade entre versões. É disponibilizado "tal como está", sem
> qualquer garantia. Usas por tua conta e risco: os autores não se responsabilizam por perdas de
> dados, erros nas contas, incumprimentos legais ou quaisquer outros danos. Lê a
> [isenção de responsabilidade](#licença-e-isenção-de-responsabilidade) antes de usar com dados
> reais.

## Funcionalidades

**Finanças**

- Orçamento anual e suplementar, com geração automática das quotas por permilagem e fundo comum de
  reserva (FCR).
- Cobranças (quotas ordinárias, quotas extraordinárias, refaturações) e despesas, com fornecedores e
  despesas recorrentes.
- Contas bancárias e caixa, importação de extratos (XLSX do Novo Banco) e conciliação bancária com
  sugestões por palavras-chave.
- Recibos em PDF enviados por email, lembretes de cobrança e planos de pagamento.
- Contabilidade em partidas dobradas com ledger imutável e plano de contas.
- Relatórios: movimentos do ano, previsão de tesouraria e execução do orçamento por ata.

**Condomínio**

- Frações, condóminos e ocupantes (proprietários, residentes, inquilinos), com importação a partir
  de folha de cálculo.
- Assembleias: convocatórias por fração, folha de presenças, procurações, ordem do dia, votações e
  ata em PDF.
- Seguros das frações: apólices, comprovativos, leitura das datas a partir do PDF, lembretes e
  renovações.
- Manutenção: inspeções periódicas, ocorrências e patologias do edifício.
- Documentos do condomínio, com controlo de visibilidade.

**Portal do condómino**

- Conta corrente, quotas e recibos da fração.
- Assembleias, convocatórias, orçamento e documentos.
- Ocorrências, seguros e patologias.

**Plataforma**

- Vários condomínios na mesma instalação, com papéis de super-administrador, administrador e
  condómino.
- Registo de auditoria das alterações.
- API REST em JSON, com especificação OpenAPI em `static/docs/swagger.json`.

## Arquitetura

| Componente      | Tecnologia                                                              |
| --------------- | ----------------------------------------------------------------------- |
| API (`3000`)    | [Deno](https://deno.com) + Hono, REST/JSON com JWT                      |
| Painel (`3400`) | Renderização no servidor com Vento, HTMX, Tailwind e daisyUI            |
| Dados           | PostgreSQL 18 (Drizzle ORM e triggers PL/pgSQL), Valkey para as sessões |
| Ficheiros       | Armazenamento compatível com S3 (RustFS em desenvolvimento)             |
| Email           | SMTP (Mailpit em desenvolvimento)                                       |

O painel não acede à base de dados: consome a API através de um cliente partilhado.

## Começar em local

Precisas de [Docker](https://docs.docker.com/get-docker/) com Docker Compose.

```bash
git clone <url-do-repositório> mague
cd mague
cp .env.example .env
docker compose up -d --build
docker compose exec api deno task migrate
docker compose exec api deno task seed:maximum
```

A primeira construção das imagens demora alguns minutos. Depois abre o painel em
<http://localhost:3400> e entra com `super@mague.pt` e a palavra-passe `test`.

| Serviço                           | Endereço                |
| --------------------------------- | ----------------------- |
| Painel                            | <http://localhost:3400> |
| API                               | <http://localhost:3000> |
| Emails enviados (Mailpit)         | <http://localhost:8025> |
| Consola do armazenamento (RustFS) | <http://localhost:9001> |

Os dados de exemplo são fictícios. Há três conjuntos:

| Comando                  | O que cria                                                      |
| ------------------------ | --------------------------------------------------------------- |
| `deno task seed`         | Utilizadores `super` e `admin` e um condomínio vazio            |
| `deno task seed:minimal` | Um condomínio com frações, condóminos e conta bancária          |
| `deno task seed:maximum` | Cinco condomínios com orçamentos, quotas, despesas e movimentos |

Todos os utilizadores de exemplo têm a palavra-passe `test`. Cada seed começa por **apagar os dados
existentes** na base de dados.

Para parar: `docker compose down`. Para apagar também os dados: `docker compose down -v`.

Se as portas `3000`, `3400`, `5432`, `6379`, `9000`, `9001`, `1025` ou `8025` estiverem ocupadas,
altera o mapeamento em `docker-compose.yml`.

## Testes

Com [Deno](https://deno.com) 2 instalado na tua máquina e o ficheiro `.env` criado no passo anterior
(os testes leem dele a configuração):

```bash
PANEL_CONDOMINIUM_ID=c1 deno task test:unit   # testes unitários, sem base de dados
deno task test:up && deno task test:sql       # testes pgTAP ao schema
deno task test:api                            # testes HTTP contra a API em execução
```

Os testes `test:sql` e `test:api` precisam da stack do Docker Compose a correr, e os `test:api`
escrevem na base de dados de desenvolvimento. Os detalhes estão em
[docs/agents/operations.md](docs/agents/operations.md).

## Estrutura do repositório

```
src/apps/api      API REST
src/apps/panel    Painel de administração e portal do condómino
src/shared        Código partilhado (cliente da API e regras puras)
src/db            Schema, components SQL e dados de exemplo
test_api          Testes HTTP contra a API
test_sql          Testes pgTAP
docs              Decisões de arquitetura, fluxos de domínio e operações
deploy, scripts   Utilitários de operação
```

## Documentação

- [CONTEXT.md](CONTEXT.md): glossário do domínio e convenções de vocabulário.
- [docs/adr/](docs/adr/README.md): decisões de arquitetura em vigor.
- [docs/flows/](docs/flows/): fluxos financeiros (quotas, despesas, FCR, conciliação, imputação).
- [docs/agents/operations.md](docs/agents/operations.md): testes, schema, cópias de segurança.
- `CLAUDE.md` (na raiz e em `src/`): regras de trabalho para agentes de IA que contribuam com
  código.

## Usar com dados reais

O Mague ainda não é recomendado para produção. Se decidires usá-lo mesmo assim:

- `docker-compose.prod.yml` e `.env.prod.example` são um ponto de partida, não uma instalação
  pronta. Precisas de um reverse proxy com TLS e de rever toda a configuração.
- Gera segredos próprios (`SESSION_SECRET`, palavra-passe da base de dados, chaves S3) e nunca uses
  os dados de exemplo: criam contas com uma palavra-passe pública.
- Faz cópias de segurança e testa a reposição.
- O software trata dados pessoais (nomes, contactos, NIF, dados financeiros). Quem o instala é o
  responsável pelo tratamento desses dados e pelo cumprimento do RGPD e da restante legislação. O
  Mague não garante esse cumprimento.
- Os documentos que o Mague gera (recibos, convocatórias, atas, mapas de quotas) são modelos. Não
  constituem aconselhamento jurídico, contabilístico ou fiscal: valida-os com profissionais
  qualificados.

## Contribuir

Issues e pull requests são bem-vindos. Ao contribuir, aceitas que a tua contribuição fica sob a
mesma licença do projeto. O projeto é mantido em tempo livre: não há garantia de resposta, de
suporte nem de correções.

Se encontrares uma vulnerabilidade de segurança, não abras uma issue pública: usa o aviso privado de
segurança do GitHub (separador "Security" do repositório).

## Licença e isenção de responsabilidade

O Mague é distribuído sob a [Licença Apache 2.0](LICENSE). Podes usar, copiar, modificar e
distribuir o software, incluindo para fins comerciais, desde que mantenhas os avisos de licença e de
direitos de autor.

O software é fornecido **"tal como está", sem garantias ou condições de qualquer tipo**, expressas
ou implícitas, incluindo garantias de comercialização, de adequação a um fim específico e de não
violação de direitos. **Em caso algum os autores ou contribuidores são responsáveis** por quaisquer
danos, diretos ou indiretos, que resultem do uso ou da impossibilidade de uso do software, incluindo
perda de dados, erros contabilísticos, prejuízos financeiros ou sanções legais. As condições
completas estão nas secções 7 e 8 da licença.

A licença não concede direitos sobre o nome "Mague" nem sobre a sua identidade visual, para além do
uso necessário para indicar a origem do software.

Copyright 2026 Os autores do Mague. Os componentes de terceiros estão identificados em
[NOTICE](NOTICE).
