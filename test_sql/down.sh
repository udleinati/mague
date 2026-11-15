#!/bin/sh
# test-sql/down.sh - Destrói toda a infraestrutura (containers, volumes, rede)
set -e

cd "$(cd "$(dirname "$0")/.." && pwd)"

echo "→ A destruir infraestrutura (containers + volumes)..."
docker compose down -v

echo "✓ Tudo removido."
