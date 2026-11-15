-- 012_view_budget_quota_map.sql
-- Vista `finance.v_budget_quota_map` - matriz unidade × valores por orçamento.
-- Calcula a quota por fração a partir da permilagem. O divisor é:
--   - principal: 12 (quota mensal, ano inteiro);
--   - suplementar: `installments` (valor por prestação, obra paga em N vezes).
-- `COALESCE(installments, 12)` cobre suplementares legados sem N definido.
-- monthly_base/total_cents = valor por mês/prestação; annual_total_cents =
-- total faturado à fração (mensal × divisor) = parte da obra ou do ano.

DROP VIEW IF EXISTS finance.v_budget_quota_map;
CREATE VIEW finance.v_budget_quota_map AS
 WITH total_pm AS (
         SELECT unit.condominium_id,
            sum((unit.permillage)::numeric) AS total
           FROM core.unit
          WHERE ((unit.is_active = true) AND (unit.deleted_at IS NULL))
          GROUP BY unit.condominium_id
        ), budget_annual AS (
         SELECT b.id AS budget_id,
            b.condominium_id,
            b.year,
            b.type,
            b.status,
            (b.fcr_percentage)::numeric AS fcr_percentage,
            b.quotas_generated_at,
            COALESCE(b.installments, 12) AS divisor,
            (COALESCE(sum(bl.annual_amount), (0)::bigint))::integer AS annual_ordinary
           FROM (core.budget b
             LEFT JOIN core.budget_line bl ON (((bl.budget_id = b.id) AND (bl.deleted_at IS NULL))))
          WHERE (b.deleted_at IS NULL)
          GROUP BY b.id, b.condominium_id, b.year, b.type, b.status, b.fcr_percentage, b.quotas_generated_at, b.installments
        ), per_unit AS (
         SELECT ba.budget_id,
            ba.condominium_id,
            ba.year,
            ba.type AS budget_type,
            ba.status AS budget_status,
            ba.quotas_generated_at,
            ba.fcr_percentage,
            ba.annual_ordinary,
            ba.divisor,
            u.id AS unit_id,
            u.designation AS unit_designation,
            (u.permillage)::numeric AS unit_permillage,
            tp.total AS total_permillage,
            (round(((((ba.annual_ordinary)::numeric / (ba.divisor)::numeric) * (u.permillage)::numeric) / tp.total)))::integer AS monthly_base_cents
           FROM ((budget_annual ba
             JOIN core.unit u ON (((u.condominium_id = ba.condominium_id) AND (u.is_active = true) AND (u.deleted_at IS NULL))))
             JOIN total_pm tp ON ((tp.condominium_id = ba.condominium_id)))
        )
 SELECT budget_id,
    condominium_id,
    year,
    budget_type,
    budget_status,
    quotas_generated_at,
    fcr_percentage,
    unit_id,
    unit_designation,
    unit_permillage,
    total_permillage,
    annual_ordinary,
    monthly_base_cents,
    (round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric)))::integer AS monthly_fcr_cents,
    (((monthly_base_cents)::numeric + round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric))))::integer AS monthly_total_cents,
    ((((monthly_base_cents)::numeric + round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric))) * (divisor)::numeric))::integer AS annual_total_cents
   FROM per_unit;
