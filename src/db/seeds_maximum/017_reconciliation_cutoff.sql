-- 017_reconciliation_cutoff.sql - marca reconciled_through_date.
-- O cutoff é o driver de "vencida" em v_unit_balance: due_date <= cutoff E
-- status open|partial → overdue; sem cutoff (NULL) → 0 overdues (não acusamos
-- atraso sem o admin afirmar que reconciliou). Março/2026 deixa centenas de
-- quotas 2025/2026 em atraso - cenário de carga para listagens "Vencidas".

UPDATE core.condominium
   SET reconciled_through_date = '2026-03-31'
 WHERE id LIKE 'condo_max_%';
