#!/bin/sh
# test-sql/run.sh - Executa testes pgTAP via Docker
# Uso: ./test-sql/run.sh [glob]
# Exemplo: ./test-sql/run.sh "/tests/001_*.sql"
#          ./test-sql/run.sh                     (todos os testes)
# Pré-requisito: deno task test:up

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GLOB="${1:-/tests/*.sql}"
DB_CONTAINER="mague-db"
NETWORK="mague_default"
IMAGE_RUNNER="mague-pgtap"

# ── Verificações ─────────────────────────────────────────────────────────────

if ! docker network inspect "$NETWORK" > /dev/null 2>&1; then
  echo "Erro: rede '$NETWORK' não encontrada. Execute primeiro: deno task test:up"
  exit 1
fi

if ! docker inspect "$DB_CONTAINER" > /dev/null 2>&1; then
  echo "Erro: container '$DB_CONTAINER' não está a correr. Execute primeiro: deno task test:up"
  exit 1
fi

if ! docker image inspect "$IMAGE_RUNNER" > /dev/null 2>&1; then
  echo "Erro: imagem '$IMAGE_RUNNER' não encontrada. Execute primeiro: deno task test:up"
  exit 1
fi

echo "→ A executar testes..."

# ── Executar pg_prove ────────────────────────────────────────────────────────

docker run --rm --network "$NETWORK" \
  -v "$SCRIPT_DIR/tests:/tests:ro" \
  -e PGHOST="$DB_CONTAINER" \
  -e PGUSER=mague \
  -e PGPASSWORD=mague \
  -e PGDATABASE=mague \
  --entrypoint sh \
  "$IMAGE_RUNNER" \
  -c "pg_prove -v $GLOB"

