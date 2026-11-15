-- 000_wipe.sql - Limpa TODOS os dados de negócio (preserva _migrations)
-- Ordem respeita dependências de FK (filhos primeiro, pais depois).
--
-- Bypass triggers de imutabilidade (finance.ledger via component 014,
-- audit.cdc_log via component 013). OK em seed - partimos do zero, não
-- estamos a alterar histórico real.
SET LOCAL session_replication_role = replica;

-- 1. Tabelas-folha (nada as referencia)
DELETE FROM core.insurance_reminder;
DELETE FROM core.insurance_policy;
DELETE FROM core.assembly_agenda_item;
DELETE FROM core.recurring_generation_run;
DELETE FROM core.recurring_template;
DELETE FROM finance.ledger;
DELETE FROM core.budget_line;
DELETE FROM core.unit_occupant;
DELETE FROM core.occupant;
DELETE FROM core.attachment;
DELETE FROM core.ticket_comment;
DELETE FROM core.ticket;
DELETE FROM core.quota_generation_run;
DELETE FROM core.invite_token;
DELETE FROM audit.cdc_log;
DELETE FROM audit.email_log;

-- 2. Tabelas que dependem de assembly/budget/condominium mas já não têm filhos
DELETE FROM finance.settlement;
DELETE FROM finance.fiscal_year;
DELETE FROM core.assembly;
DELETE FROM core.inspection;
DELETE FROM finance.receipt;

-- 3. Tabelas intermédias
DELETE FROM finance.bank_transaction;
DELETE FROM finance.bank_import_batch;
DELETE FROM finance.bank_account;
DELETE FROM finance.charge;
DELETE FROM finance.charge_code_counter;
DELETE FROM core.supplier;
DELETE FROM core.budget;
DELETE FROM finance.chart_of_account;
DELETE FROM core.unit;
DELETE FROM core.manager;

DELETE FROM core.condominium;
DELETE FROM core."user";
