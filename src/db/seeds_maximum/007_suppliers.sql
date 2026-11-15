-- 007_suppliers.sql - 5 fornecedores por condomínio (limpeza, eletricidade,
-- elevador, gás, manutenção). 25 fornecedores no total.
--
-- Estes nomes/keywords são usados depois para gerar charges payable
-- (despesas) com descrições realistas.
--
-- Nota: arrays multidimensionais em PG exigem sublistas com o mesmo
-- comprimento - usamos `string_to_array` com keywords separadas por
-- vírgulas para evitar essa restrição.

DO $$
DECLARE
  c_idx int;
  i int;
  supplier_names text[] := ARRAY['Limpeza Lisboa Lda', 'Eletricidade EDP', 'Elevadores Schindler', 'Gás Galp', 'Manutenção Geral'];
  supplier_codes text[] := ARRAY['lim', 'edp', 'ele', 'gas', 'man'];
  supplier_keyword_csv text[] := ARRAY[
    'limpeza,clean',
    'edp,eletricidade,luz',
    'elevador,schindler',
    'galp,gas,gás',
    'manutencao,manutenção,obras'
  ];
BEGIN
  FOR c_idx IN 1..5 LOOP
    FOR i IN 1..5 LOOP
      INSERT INTO core.supplier (
        id, condominium_id, name, contact_email, match_keywords
      )
      VALUES (
        'sup_max_' || c_idx || '_' || supplier_codes[i],
        'condo_max_' || c_idx,
        supplier_names[i],
        lower(supplier_codes[i]) || '-' || c_idx || '@fornecedor.pt',
        string_to_array(supplier_keyword_csv[i], ',')
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
