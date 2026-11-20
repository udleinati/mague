-- 004_receipt_settlement_ids.sql
-- Conciliações que cada recibo cobre. Um movimento consumido aos poucos (ex.: depósito da
-- seguradora) gera vários recibos para a mesma fração, um por conciliação nova.
-- Sem backfill: recibo com array vazio (anterior a esta migration ou emitido por código
-- antigo) cobre as conciliações do par feitas até à emissão (finance.vw_receipted_settlements).

ALTER TABLE finance.receipt ADD COLUMN settlement_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN finance.receipt.settlement_ids IS 'Settlements cobertos por este recibo. Vazio = recibo anterior à regra: cobre os do par criados até issued_at.';
