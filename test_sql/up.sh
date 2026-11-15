#!/bin/sh
# test-sql/up.sh - Reset da BD para rodar pgTAP tests num estado conhecido.
#
# Levanta a stack (`docker compose up -d`) se algum container estiver em
# falta ou parado, depois re-aplica migrations + seed. NÃO destrói
# containers nem volumes - só garante que estão em pé.
#
# Para teardown completo de containers+volumes: `deno task test:down`.
#
# Uso:
#   ./test_sql/up.sh              → seed completo (deno task seed)
#   ./test_sql/up.sh seed:minimal → seed mínimo
set -e

SEED_TASK="${1:-seed}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_CONTAINER="mague-db"

cd "$PROJECT_DIR"

# ── 1. Garantir que a stack está em pé ──────────────────────────────────────
# Se o container db estiver missing/stopped, sobe tudo. `up -d` é
# idempotente - re-correr quando já está a correr é no-op.
status="$(docker inspect --format='{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo missing)"
if [ "$status" != "running" ]; then
  echo "→ Container '$DB_CONTAINER' (status: $status) - a levantar a stack..."
  docker compose up -d
fi

# ── 2. Aguardar healthy (pode estar a iniciar) ──────────────────────────────
echo "→ A aguardar que o PostgreSQL fique healthy..."
tries=0
until docker inspect --format='{{.State.Health.Status}}' "$DB_CONTAINER" 2>/dev/null | grep -q "healthy"; do
  tries=$((tries + 1))
  if [ $tries -gt 30 ]; then
    echo "✗ Timeout à espera que '$DB_CONTAINER' fique healthy."
    exit 1
  fi
  sleep 1
done

# ── 3. Migrações (001_bootstrap.sql + components) ───────────────────────────
echo "→ A executar migrações..."
deno task migrate

# ── 4. Seed (wipe + inserts) ────────────────────────────────────────────────
echo "→ A executar seed (${SEED_TASK})..."
deno task "$SEED_TASK"

# ── 5. Activar extensão pgTAP ───────────────────────────────────────────────
echo "→ A garantir extensão pgTAP..."
docker exec "$DB_CONTAINER" psql -U mague -d mague \
  -c "CREATE EXTENSION IF NOT EXISTS pgtap;" > /dev/null

# Sem helpers SQL de teste: a state machine de settlement e os geradores
# (quotas, recorrentes) vivem em TS (ADR 0001), não em triggers. A cobertura
# desses fluxos é e2e (test_api/).

# ── 6. Build da imagem pg_prove runner ───────────────────────────────────────
echo "→ A garantir imagem pg_prove runner..."
docker build -q -t mague-pgtap -f "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR" > /dev/null

echo ""
echo "✓ BD pronta para tests. Login: http://localhost:3400 - super@mague.pt / test"
echo ""
