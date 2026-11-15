-- 000a_chart_of_account_global.sql
-- Plano de contas GLOBAL - padrão SNC (Sistema de Normalização Contabilística
-- português, versão CNC 070703), adaptado a condomínios.
-- condominium_id = NULL → conta global. Corre após o wipe.

INSERT INTO finance.chart_of_account (code, condominium_id, name, type, parent_code, description)
VALUES
  -- ════ CLASSE 1 - MEIOS FINANCEIROS LÍQUIDOS ════
  ('1',     NULL, 'Meios Financeiros Líquidos',                       'asset',     NULL,  NULL),
  ('11',    NULL, 'Caixa',                                            'asset',     '1',   NULL),
  ('12',    NULL, 'Depósitos à ordem',                                'asset',     '1',   NULL),
  ('121',   NULL, 'Depósitos à ordem - Conta Ordinária',              'asset',     '12',  'Conta corrente principal do condomínio'),
  ('122',   NULL, 'Depósitos à ordem - Conta FCR',                    'asset',     '12',  'Conta FCR - bolsa reservada Art. 1424.º-A CC'),

  -- ════ CLASSE 2 - CONTAS A RECEBER E A PAGAR ════
  ('2',     NULL, 'Contas a Receber e a Pagar',                       'liability', NULL,  'Mistura asset (receivables) e liability (payables)'),
  ('21',    NULL, 'Clientes',                                         'asset',     '2',   NULL),
  ('211',   NULL, 'Clientes c/c',                                     'asset',     '21',  NULL),
  ('2111',  NULL, 'Condóminos - Quotas Ordinárias',                   'asset',     '211', 'A Receber de quotas mensais'),
  ('2112',  NULL, 'Condóminos - Quotas Extraordinárias',              'asset',     '211', 'A Receber de quotas de obra / extraordinárias'),
  ('2113',  NULL, 'Condóminos - Refaturações',                       'asset',     '211', 'Refaturação de despesas individualizáveis'),
  ('22',    NULL, 'Fornecedores',                                     'liability', '2',   NULL),
  ('221',   NULL, 'Fornecedores c/c',                                 'liability', '22',  NULL),
  ('2211',  NULL, 'Fornecedores a Pagar',                             'liability', '221', 'Faturas de fornecedores pendentes'),
  ('27',    NULL, 'Outras contas a receber e a pagar',                'asset',     '2',   NULL),
  ('278',   NULL, 'Outros devedores e credores',                      'asset',     '27',  NULL),
  ('2781',  NULL, 'Outros Devedores',                                 'asset',     '278', 'Devedores diversos'),
  ('2782',  NULL, 'Outros Credores',                                  'liability', '278', 'Ex: condómino a reembolsar, assembleia a pagar'),
  ('2789',  NULL, 'Valores a Classificar',                            'liability', '278', 'Suspense: entradas/saídas sem identificação'),

  -- ════ CLASSE 5 - CAPITAL, RESERVAS E RESULTADOS TRANSITADOS ════
  ('5',     NULL, 'Capital, Reservas e Resultados Transitados',       'equity',    NULL,  NULL),
  ('58',    NULL, 'Reservas',                                         'equity',    '5',   NULL),
  ('581',   NULL, 'Fundo Comum de Reserva',                           'equity',    '58',  'Saldo acumulado do FCR (Art. 1424.º-A CC)'),
  ('59',    NULL, 'Resultados Transitados',                           'equity',    '5',   'Excedentes / défices de exercícios anteriores'),

  -- ════ CLASSE 6 - GASTOS ════
  ('6',     NULL, 'Gastos',                                           'expense',   NULL,  NULL),
  ('62',    NULL, 'Fornecimentos e serviços externos',                'expense',   '6',   NULL),
  ('622',   NULL, 'Serviços especializados',                          'expense',   '62',  NULL),
  ('6221',  NULL, 'Trabalhos especializados (Obras Extraordinárias)', 'expense',   '622', 'Pintura, impermeabilização, estruturais'),
  ('6223',  NULL, 'Vigilância e segurança',                           'expense',   '622', 'Extintores, carreteis, portas corta-fogo, desenfumagem, deteção e alarme de incêndio, inspeção da coluna de gás'),
  ('6224',  NULL, 'Honorários',                                       'expense',   '622', 'Pagamento à empresa ou administrador do condomínio'),
  ('6226',  NULL, 'Conservação e reparação',                          'expense',   '622', 'Limpeza, jardinagem, elevador, etc. (âncora)'),
  ('62261', NULL, 'Conservação do edifício',                          'expense',   '6226','Reparações preventivas e trabalhos de conservação da estrutura e acabamentos'),
  ('62262', NULL, 'Manutenção geral do edifício',                     'expense',   '6226','Reparações correctivas e manutenção geral de zonas comuns'),
  ('62263', NULL, 'Espaços verdes',                                   'expense',   '6226','Jardinagem, rega, poda, tratamentos fitossanitários'),
  ('62264', NULL, 'Elevadores - manutenção',                          'expense',   '6226','Contrato de manutenção periódica dos elevadores'),
  ('62265', NULL, 'Elevadores - inspeção periódica',                  'expense',   '6226','Inspeções regulamentares (EMEE / ISQ)'),
  ('62266', NULL, 'Portão automático',                                'expense',   '6226','Manutenção e reparação do portão da garagem ou entrada'),
  ('62267', NULL, 'Bombas de fossa',                                  'expense',   '6226','Manutenção das bombas de esgoto/fossa séptica'),
  ('623',   NULL, 'Materiais',                                        'expense',   '62',  NULL),
  ('6231',  NULL, 'Ferramentas e utensílios (Material de manutenção)','expense',   '623', 'Consumíveis, lâmpadas, parafusos, tintas, ferramentas'),
  ('6233',  NULL, 'Material de escritório (Despesas administrativas)','expense',   '623', 'Material de escritório, correio, cópias'),
  ('624',   NULL, 'Energia e fluidos',                                'expense',   '62',  NULL),
  ('6241',  NULL, 'Eletricidade',                                    'expense',   '624', 'Consumo elétrico das zonas comuns (iluminação, elevadores, bombas)'),
  ('6243',  NULL, 'Água',                                             'expense',   '624', 'Consumo de água das zonas comuns (rega, limpeza, sanitários)'),
  ('626',   NULL, 'Serviços diversos',                                'expense',   '62',  NULL),
  ('6262',  NULL, 'Comunicação',                                      'expense',   '626', 'Telefone (ex: linha de emergência dos elevadores), comunicações administrativas'),
  ('6263',  NULL, 'Seguros',                                          'expense',   '626', 'Multirriscos, responsabilidade civil'),
  ('6265',  NULL, 'Contencioso e notariado',                          'expense',   '626', 'Honorários legais, custas judiciais, execuções fiscais'),
  ('6267',  NULL, 'Limpeza, higiene e conforto',                      'expense',   '626', 'Limpeza de escadas, corredores, entradas, átrios'),
  ('62671', NULL, 'Limpeza - garagem',                                'expense',   '6267','Limpeza da garagem comum'),
  ('6268',  NULL, 'Outros serviços',                                  'expense',   '626', 'Outras despesas não classificadas noutra rubrica'),
  ('68',    NULL, 'Outros gastos e perdas',                           'expense',   '6',   NULL),
  ('681',   NULL, 'Impostos',                                         'expense',   '68',  NULL),
  ('6813',  NULL, 'Taxas',                                            'expense',   '681', 'Autárquicos, IMT, etc.'),
  ('69',    NULL, 'Gastos e perdas de financiamento',                 'expense',   '6',   NULL),
  ('698',   NULL, 'Outros gastos e perdas de financiamento',          'expense',   '69',  NULL),
  ('6988',  NULL, 'Despesas bancárias',                               'expense',   '698', 'Comissões bancárias, manutenção de conta, emissão de cheques'),

  -- ════ CLASSE 7 - RENDIMENTOS ════
  ('7',     NULL, 'Rendimentos',                                      'revenue',   NULL,  NULL),
  ('72',    NULL, 'Prestações de serviços',                           'revenue',   '7',   NULL),
  ('721',   NULL, 'Quotas Ordinárias',                                'revenue',   '72',  'Parte ordinária das quotas emitidas'),
  ('722',   NULL, 'Quotas Extraordinárias',                           'revenue',   '72',  'Quotas de obra / suplementares'),
  ('723',   NULL, 'Contribuições FCR',                                'revenue',   '72',  'Parte FCR das quotas (10% sobre ordinárias)'),
  ('75',    NULL, 'Subsídios à exploração',                           'revenue',   '7',   NULL),
  ('751',   NULL, 'Subsídios do Estado e outros entes públicos',      'revenue',   '75',  'Autárquicos, estatais'),
  ('78',    NULL, 'Outros rendimentos e ganhos',                      'revenue',   '7',   NULL),
  ('781',   NULL, 'Rendimentos suplementares',                        'revenue',   '78',  NULL),
  ('787',   NULL, 'Rendimentos em investimentos não financeiros',     'revenue',   '78',  NULL),
  ('7872',  NULL, 'Sinistros (Indemnizações de Seguros)',             'revenue',   '787', NULL),
  ('7873',  NULL, 'Rendas e outros rendimentos em propriedades',      'revenue',   '787', 'Aluguer de espaços comuns (antena, publicidade, etc.)'),
  ('788',   NULL, 'Outros',                                           'revenue',   '78',  NULL),
  ('7888',  NULL, 'Outras Receitas',                                  'revenue',   '788', 'Outros não especificados'),
  ('79',    NULL, 'Rendimentos e ganhos de financiamento',            'revenue',   '7',   NULL),
  ('791',   NULL, 'Juros obtidos',                                    'revenue',   '79',  NULL),
  ('7911',  NULL, 'Rendimentos Financeiros',                          'revenue',   '791', 'Juros bancários, aplicações');
