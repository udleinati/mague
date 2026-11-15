#!/bin/sh
# test_api/up_isolated.sh - prepara uma BD de teste SEPARADA para o test:api.
#
# Porquê: `deno task test:up` corre `deno task seed`, que faz wipe + inserts na
# BD `mague` - a de desenvolvimento. Quem só quer correr os testes de API perdia
# os dados de dev. Este script cria/reseeda `mague_test` e deixa `mague` intacta.
#
# Uso:
#   ./test_api/up_isolated.sh              → seed completo
#   ./test_api/up_isolated.sh seed:minimal → seed mínimo
#
# Depois: `deno task test:api:isolated` (aponta a API e a suite à mesma BD).
set -e

SEED_TASK="${1:-seed}"
DB_CONTAINER="mague-db"
TEST_DB="mague_test"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PROJECT_DIR"

status="$(docker inspect --format='{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo missing)"
if [ "$status" != "running" ]; then
  echo "→ Container '$DB_CONTAINER' ($status) - a levantar a stack..."
  docker compose up -d
fi

echo "→ A aguardar PostgreSQL healthy..."
tries=0
until docker inspect --format='{{.State.Health.Status}}' "$DB_CONTAINER" 2>/dev/null | grep -q healthy; do
  tries=$((tries + 1))
  [ $tries -gt 30 ] && { echo "✗ Timeout."; exit 1; }
  sleep 1
done

echo "→ A recriar '$TEST_DB' (a BD 'mague' de dev NÃO é tocada)..."
docker exec "$DB_CONTAINER" psql -U mague -d postgres -q \
  -c "DROP DATABASE IF EXISTS $TEST_DB;" -c "CREATE DATABASE $TEST_DB OWNER mague;"

export DATABASE_URL="postgres://mague:mague@localhost:5432/$TEST_DB"
echo "→ Migrações..."
deno task migrate
echo "→ Seed (${SEED_TASK})..."
deno task "$SEED_TASK"

echo "→ A apontar a API para '$TEST_DB' (bucket S3 próprio)..."
docker compose -f docker-compose.yml -f test_api/docker-compose.isolated.yml up -d api
printf "→ A aguardar a API"
tries=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"super@mague.pt","password":"test"}')" = "200" ]; do
  tries=$((tries + 1))
  [ $tries -gt 30 ] && { echo " ✗ a API não respondeu."; exit 1; }
  printf "."
  sleep 2
done
echo " ok"

echo ""
echo "✓ Pronto. Correr:   deno task test:api:isolated"
echo "  Repor a API dev:  deno task test:api:restore"
echo ""
