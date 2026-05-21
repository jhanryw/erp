-- =============================================================================
-- SANTTORINI ERP — TESTES DE INTEGRIDADE PRÉ-LANÇAMENTO
-- Versão: 2026-05-21
--
-- INSTRUÇÕES:
--   Execute no Supabase SQL Editor (ou psql).
--   Leitura somente — nenhum dado é alterado.
--   Resultado esperado: coluna "resultado" com ✓ PASSOU em todos os testes.
--   Qualquer ✗ FALHOU ou ⚠ ATENÇÃO requer investigação antes do lançamento.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: função local de teste (existe apenas nesta sessão)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  RAISE NOTICE 'Iniciando testes de integridade pré-lançamento...';
END $$;

-- =============================================================================
-- BLOCO 1: ESTRUTURA DO BANCO
-- =============================================================================

WITH resultados AS (

  -- T01: mv_stock_status usa stock.quantity (não stock_lots)
  SELECT
    'T01' AS id,
    'mv_stock_status usa fonte correta (stock.quantity)' AS descricao,
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace)
        THEN '✗ FALHOU — view não existe'
      WHEN pg_get_viewdef('public.mv_stock_status'::regclass, true) ILIKE '%stock_lots%'
        THEN '✗ FALHOU — usa stock_lots (migration 036 ativa, estoque na UI errado)'
      ELSE '✓ PASSOU'
    END AS resultado,
    'Estoque exibido incorretamente para todos os produtos' AS impacto_se_falhar

  UNION ALL

  -- T02: mv_stock_status é VIEW regular (não materializada — não precisa de REFRESH)
  SELECT
    'T02',
    'mv_stock_status é VIEW regular (não materializada)',
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace AND relkind='m')
        THEN '⚠ ATENÇÃO — é MATERIALIZED VIEW, dados podem estar desatualizados'
      WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace AND relkind='v')
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — view não existe'
    END,
    'Tela de estoque mostra dados com atraso de até 1 hora'

  UNION ALL

  -- T03: Tabelas obrigatórias existem
  SELECT
    'T03',
    'Todas as tabelas obrigatórias existem',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          VALUES ('stock'),('stock_lots'),('stock_movements'),
                 ('products'),('product_variations'),('product_variation_attributes'),
                 ('sales'),('sale_items'),('customers'),('users'),('companies'),
                 ('finance_entries'),('pedidos'),('pedidos_itens'),('estoque_movimentacoes'),
                 ('produto_map'),('nuvemshop_sync_logs'),('categories'),('suppliers')
        ) AS t(nome)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_tables pt
          WHERE pt.schemaname = 'public' AND pt.tablename = t.nome
        )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — tabelas faltando: ' || (
        SELECT STRING_AGG(nome, ', ')
        FROM (
          VALUES ('stock'),('stock_lots'),('stock_movements'),
                 ('products'),('product_variations'),('product_variation_attributes'),
                 ('sales'),('sale_items'),('customers'),('users'),('companies'),
                 ('finance_entries'),('pedidos'),('pedidos_itens'),('estoque_movimentacoes'),
                 ('produto_map'),('nuvemshop_sync_logs'),('categories'),('suppliers')
        ) AS t(nome)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_tables pt
          WHERE pt.schemaname='public' AND pt.tablename=t.nome
        )
      )
    END,
    'Funcionalidades inteiras do sistema vão falhar'

  UNION ALL

  -- T04: stock_movements NÃO tem colunas notes e created_by (schema correto)
  SELECT
    'T04',
    'stock_movements não tem colunas legadas (notes, created_by)',
    CASE
      WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='stock_movements'
          AND column_name IN ('notes','created_by')
      )
        THEN '⚠ ATENÇÃO — colunas legadas presentes: ' || (
          SELECT STRING_AGG(column_name, ', ')
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stock_movements'
            AND column_name IN ('notes','created_by')
        )
      ELSE '✓ PASSOU'
    END,
    'rpc_nuvemshop_sale_deduct pode inserir dados em colunas inesperadas'

  UNION ALL

  -- T05: Colunas obrigatórias de stock_movements existem
  SELECT
    'T05',
    'stock_movements tem todas as colunas obrigatórias',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          VALUES ('id'),('product_variation_id'),('product_id'),('company_id'),
                 ('type'),('quantity'),('previous_stock'),('new_stock'),
                 ('unit_cost'),('reference_id'),('created_at')
        ) AS t(col)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='public' AND c.table_name='stock_movements' AND c.column_name=t.col
        )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — colunas faltando em stock_movements'
    END,
    'RPCs de estoque vão falhar ao inserir movimentações'

  UNION ALL

  -- T06: Trigger de proteção de stock existe e está ativo
  SELECT
    'T06',
    'Trigger trg_prevent_direct_stock_write existe em stock',
    CASE
      WHEN EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_schema='public'
          AND trigger_name='trg_prevent_direct_stock_write'
          AND event_object_table='stock'
      )
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — escrita direta em stock não está protegida!'
    END,
    'Qualquer código pode modificar estoque diretamente, bypassando o ledger'

  UNION ALL

  -- T07: RPCs obrigatórias existem
  SELECT
    'T07',
    'RPCs obrigatórias existem (rpc_create_sale, rpc_cancel_sale, rpc_return_sale, rpc_stock_entry, rpc_stock_adjust, rpc_stock_initialize)',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          VALUES ('rpc_create_sale'),('rpc_cancel_sale'),('rpc_return_sale'),
                 ('rpc_stock_entry'),('rpc_stock_adjust'),('rpc_stock_initialize')
        ) AS t(fn)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname=t.fn
        )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — RPCs faltando: ' || (
        SELECT STRING_AGG(fn, ', ')
        FROM (VALUES ('rpc_create_sale'),('rpc_cancel_sale'),('rpc_return_sale'),
                     ('rpc_stock_entry'),('rpc_stock_adjust'),('rpc_stock_initialize')) AS t(fn)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=t.fn
        )
      )
    END,
    'Operações de venda e estoque vão quebrar em runtime'

  UNION ALL

  -- T08: rpc_nuvemshop_sale_deduct foi removida (função perigosa/obsoleta)
  SELECT
    'T08',
    'rpc_nuvemshop_sale_deduct foi removida do banco',
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='rpc_nuvemshop_sale_deduct'
      ) THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — função existe e tenta inserir colunas que não existem em stock_movements'
    END,
    'Se chamada, vai falhar com erro de coluna inexistente'

  UNION ALL

  -- T09: RLS habilitado nas tabelas sensíveis
  SELECT
    'T09',
    'RLS habilitado em tabelas sensíveis (stock, sales, customers, finance_entries)',
    CASE
      WHEN (
        SELECT COUNT(*) FROM pg_tables
        WHERE schemaname='public'
          AND tablename IN ('stock','sales','customers','finance_entries','stock_movements')
          AND rowsecurity = false
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — RLS desabilitado em: ' || (
        SELECT STRING_AGG(tablename, ', ')
        FROM pg_tables
        WHERE schemaname='public'
          AND tablename IN ('stock','sales','customers','finance_entries','stock_movements')
          AND rowsecurity = false
      )
    END,
    'Dados de clientes/vendas/finanças podem ser expostos entre empresas'

  UNION ALL

  -- T10: Ao menos uma empresa cadastrada
  SELECT
    'T10',
    'Ao menos uma empresa (company) cadastrada',
    CASE WHEN (SELECT COUNT(*) FROM companies WHERE active = true) > 0
      THEN '✓ PASSOU'
      ELSE '✗ FALHOU — nenhuma empresa ativa cadastrada'
    END,
    'Nenhum dado pode ser criado sem company_id'

  UNION ALL

  -- T11: Ao menos um usuário com role gerente
  SELECT
    'T11',
    'Ao menos um usuário com role gerente ou admin',
    CASE WHEN (SELECT COUNT(*) FROM users WHERE role IN ('gerente','admin') AND active = true) > 0
      THEN '✓ PASSOU'
      ELSE '✗ FALHOU — nenhum gerente ativo cadastrado'
    END,
    'Impossível fazer entradas de estoque, criar produtos ou cancelar vendas'

)
SELECT id, descricao, resultado, impacto_se_falhar FROM resultados ORDER BY id;

-- =============================================================================
-- BLOCO 2: CONSISTÊNCIA DE DADOS
-- =============================================================================

WITH resultados AS (

  -- T12: Nenhum registro de estoque negativo
  SELECT
    'T12' AS id,
    'Nenhuma variação com estoque negativo' AS descricao,
    CASE
      WHEN (SELECT COUNT(*) FROM stock WHERE quantity < 0) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM stock WHERE quantity < 0)::text || ' variação(ões) com qty < 0'
    END AS resultado,
    'Vendas foram processadas sem estoque suficiente (integridade comprometida)' AS impacto_se_falhar

  UNION ALL

  -- T13: Toda variação ativa tem registro em stock
  SELECT
    'T13',
    'Toda variação ativa tem registro em stock',
    CASE
      WHEN (
        SELECT COUNT(*) FROM product_variations pv
        WHERE pv.active = true
          AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.product_variation_id = pv.id)
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM product_variations pv
        WHERE pv.active=true AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.product_variation_id=pv.id)
      )::text || ' variação(ões) ativa(s) sem registro em stock'
    END,
    'Variação aparece como "sem estoque" mesmo se tiver unidades'

  UNION ALL

  -- T14: Nenhuma divergência grave entre stock.quantity e ledger stock_movements
  SELECT
    'T14',
    'Saldo de stock.quantity bate com ledger stock_movements (tolerância: 0)',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          SELECT
            s.product_variation_id,
            s.quantity AS saldo,
            COALESCE(SUM(sm.quantity), 0)::int AS soma_movimentos
          FROM stock s
          LEFT JOIN stock_movements sm ON sm.product_variation_id = s.product_variation_id
          GROUP BY s.product_variation_id, s.quantity
          HAVING s.quantity != COALESCE(SUM(sm.quantity), 0)
        ) t
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM (
          SELECT s.product_variation_id
          FROM stock s
          LEFT JOIN stock_movements sm ON sm.product_variation_id = s.product_variation_id
          GROUP BY s.product_variation_id, s.quantity
          HAVING s.quantity != COALESCE(SUM(sm.quantity), 0)
        ) t
      )::text || ' variação(ões) com divergência entre saldo e ledger'
    END,
    'Estoque visível não reflete operações realizadas'

  UNION ALL

  -- T15: Toda venda 'paid' tem ao menos um stock_movement type='sale'
  SELECT
    'T15',
    'Toda venda paid tem movimentação de estoque correspondente',
    CASE
      WHEN (
        SELECT COUNT(*) FROM sales s
        WHERE s.status = 'paid'
          AND NOT EXISTS (
            SELECT 1 FROM stock_movements sm
            WHERE sm.reference_id = s.id::text AND sm.type = 'sale'
          )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (
        SELECT COUNT(*) FROM sales s
        WHERE s.status='paid'
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.reference_id=s.id::text AND sm.type='sale')
      )::text || ' venda(s) pagas sem movimentação de estoque'
    END,
    'Vendas criadas sem debitar estoque — estoque inflado'

  UNION ALL

  -- T16: Toda venda cancelada/devolvida tem stock_movement type='return'
  SELECT
    'T16',
    'Toda venda cancelada/devolvida tem estorno de estoque correspondente',
    CASE
      WHEN (
        SELECT COUNT(*) FROM sales s
        WHERE s.status IN ('cancelled','returned')
          AND NOT EXISTS (
            SELECT 1 FROM stock_movements sm
            WHERE sm.reference_id = s.id::text AND sm.type = 'return'
          )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM sales s
        WHERE s.status IN ('cancelled','returned')
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.reference_id=s.id::text AND sm.type='return')
      )::text || ' venda(s) cancelada(s)/devolvida(s) sem estorno de estoque'
    END,
    'Cancelamentos não devolveram estoque — estoque subtraído indevidamente'

  UNION ALL

  -- T17: Toda venda paid tem finance_entry de receita
  SELECT
    'T17',
    'Toda venda paid tem lançamento financeiro (income/sale)',
    CASE
      WHEN (
        SELECT COUNT(*) FROM sales s
        WHERE s.status = 'paid'
          AND NOT EXISTS (
            SELECT 1 FROM finance_entries fe
            WHERE fe.sale_id = s.id AND fe.type = 'income' AND fe.category = 'sale'
          )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (
        SELECT COUNT(*) FROM sales s
        WHERE s.status='paid'
          AND NOT EXISTS (SELECT 1 FROM finance_entries fe WHERE fe.sale_id=s.id AND fe.type='income' AND fe.category='sale')
      )::text || ' venda(s) sem lançamento de receita'
    END,
    'Receitas não computadas no financeiro'

  UNION ALL

  -- T18: Toda entrada de estoque (stock_lot) tem finance_entry de despesa
  SELECT
    'T18',
    'Toda entrada de estoque tem lançamento financeiro (expense/stock_purchase)',
    CASE
      WHEN (
        SELECT COUNT(*) FROM stock_lots sl
        WHERE NOT EXISTS (
          SELECT 1 FROM finance_entries fe
          WHERE fe.stock_lot_id = sl.id AND fe.category = 'stock_purchase'
        )
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM stock_lots sl
        WHERE NOT EXISTS (SELECT 1 FROM finance_entries fe WHERE fe.stock_lot_id=sl.id AND fe.category='stock_purchase')
      )::text || ' lote(s) sem lançamento de custo'
    END,
    'CMV (Custo de Mercadorias Vendidas) subestimado'

  UNION ALL

  -- T19: Nenhum sale_number duplicado
  SELECT
    'T19',
    'Nenhum número de venda duplicado',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          SELECT sale_number FROM sales GROUP BY sale_number HAVING COUNT(*) > 1
        ) t
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — números de venda duplicados detectados'
    END,
    'Rastreabilidade comprometida, relatórios incorretos'

  UNION ALL

  -- T20: Nenhum SKU de variação duplicado
  SELECT
    'T20',
    'Nenhum SKU de variação duplicado',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          SELECT sku_variation FROM product_variations GROUP BY sku_variation HAVING COUNT(*) > 1
        ) t
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — SKUs duplicados: ' || (
        SELECT STRING_AGG(sku_variation, ', ')
        FROM (SELECT sku_variation FROM product_variations GROUP BY sku_variation HAVING COUNT(*) > 1 LIMIT 5) t
      )
    END,
    'Entradas de estoque podem ser aplicadas na variação errada'

)
SELECT id, descricao, resultado, impacto_se_falhar FROM resultados ORDER BY id;

-- =============================================================================
-- BLOCO 3: INTEGRIDADE DA INTEGRAÇÃO NUVEMSHOP
-- =============================================================================

WITH resultados AS (

  -- T21: Nenhum pedido pago não processado com mais de 1 hora
  SELECT
    'T21' AS id,
    'Nenhum pedido Nuvemshop pago não processado há mais de 1 hora' AS descricao,
    CASE
      WHEN (
        SELECT COUNT(*) FROM pedidos
        WHERE channel_status = 'paid'
          AND (stock_processed = false OR stock_processed IS NULL)
          AND created_at < NOW() - INTERVAL '1 hour'
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM pedidos
        WHERE channel_status='paid' AND (stock_processed=false OR stock_processed IS NULL)
          AND created_at < NOW() - INTERVAL '1 hour'
      )::text || ' pedido(s) pago(s) que nunca foram processados'
    END AS resultado,
    'Estoque não foi decrementado para essas vendas externas' AS impacto_se_falhar

  UNION ALL

  -- T22: Nenhum pedido com stock_processed=true mas sale_id nulo
  SELECT
    'T22',
    'Nenhum pedido Nuvemshop com processamento incompleto (stock_processed=true mas sem sale_id)',
    CASE
      WHEN (SELECT COUNT(*) FROM pedidos WHERE stock_processed=true AND sale_id IS NULL) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM pedidos WHERE stock_processed=true AND sale_id IS NULL)::text || ' pedido(s) inconsistentes'
    END,
    'Estado de processamento corrompido — pode causar reprocessamentos ou perdas'

  UNION ALL

  -- T23: Nenhum pedido Nuvemshop com duas vendas criadas (race condition)
  SELECT
    'T23',
    'Nenhum pedido Nuvemshop gerou vendas duplicadas no ERP',
    CASE
      WHEN (
        SELECT COUNT(*) FROM (
          SELECT p.external_id
          FROM pedidos p
          JOIN sales s ON s.notes ILIKE '%' || p.external_id || '%'
          WHERE p.source = 'nuvemshop'
          GROUP BY p.external_id
          HAVING COUNT(DISTINCT s.id) > 1
        ) t
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — pedidos com vendas duplicadas detectados!'
    END,
    'Estoque debitado duas vezes, receita duplicada no financeiro'

  UNION ALL

  -- T24: Todas as variações mapeadas na Nuvemshop têm product_variation_id válido
  SELECT
    'T24',
    'Todos os mapeamentos produto_map apontam para variações existentes',
    CASE
      WHEN (
        SELECT COUNT(*) FROM produto_map pm
        WHERE pm.product_variation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_variations pv WHERE pv.id = pm.product_variation_id)
      ) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — mapeamentos apontando para variações inexistentes'
    END,
    'Webhooks de pedidos vão ignorar itens com mapeamento quebrado'

  UNION ALL

  -- T25: Falhas recentes de sync com Nuvemshop
  SELECT
    'T25',
    'Poucas falhas de sync Nuvemshop nas últimas 24h (< 10)',
    CASE
      WHEN (SELECT COUNT(*) FROM nuvemshop_sync_logs WHERE success=false AND created_at > NOW()-INTERVAL '24h') < 10
        THEN '✓ PASSOU — ' || (SELECT COUNT(*) FROM nuvemshop_sync_logs WHERE success=false AND created_at>NOW()-INTERVAL '24h')::text || ' falha(s) nas últimas 24h'
      ELSE '⚠ ATENÇÃO — ' || (SELECT COUNT(*) FROM nuvemshop_sync_logs WHERE success=false AND created_at>NOW()-INTERVAL '24h')::text || ' falha(s) nas últimas 24h'
    END,
    'Estoque na Nuvemshop desatualizado — risco de overselling'

)
SELECT id, descricao, resultado, impacto_se_falhar FROM resultados ORDER BY id;

-- =============================================================================
-- BLOCO 4: CONFIGURAÇÃO E SEGURANÇA
-- =============================================================================

WITH resultados AS (

  -- T26: Pelo menos um produto ativo com estoque > 0
  SELECT
    'T26' AS id,
    'Existem produtos ativos com estoque disponível' AS descricao,
    CASE
      WHEN (
        SELECT COUNT(*) FROM stock s
        JOIN product_variations pv ON pv.id = s.product_variation_id
        JOIN products p ON p.id = pv.product_id
        WHERE s.quantity > 0 AND pv.active = true AND p.active = true
      ) > 0
        THEN '✓ PASSOU — ' || (
          SELECT COUNT(*) FROM stock s
          JOIN product_variations pv ON pv.id=s.product_variation_id
          JOIN products p ON p.id=pv.product_id
          WHERE s.quantity>0 AND pv.active=true AND p.active=true
        )::text || ' variação(ões) disponíveis'
      ELSE '⚠ ATENÇÃO — nenhum produto com estoque para vender'
    END AS resultado,
    'Loja não pode vender sem estoque' AS impacto_se_falhar

  UNION ALL

  -- T27: Nenhum produto sem categoria
  SELECT
    'T27',
    'Nenhum produto sem categoria válida',
    CASE
      WHEN (
        SELECT COUNT(*) FROM products p
        WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id)
      ) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (
        SELECT COUNT(*) FROM products p
        WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.id=p.category_id)
      )::text || ' produto(s) com categoria inválida'
    END,
    'Erros de FK em queries de produto'

  UNION ALL

  -- T28: Nenhum produto ativo com preço zero ou negativo
  SELECT
    'T28',
    'Nenhum produto ativo com preço <= 0',
    CASE
      WHEN (SELECT COUNT(*) FROM products WHERE active=true AND base_price <= 0) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM products WHERE active=true AND base_price<=0)::text || ' produto(s) com preço inválido'
    END,
    'Venda a preço zero gera receita zero no financeiro'

  UNION ALL

  -- T29: Nenhuma venda com total negativo
  SELECT
    'T29',
    'Nenhuma venda com total negativo',
    CASE
      WHEN (SELECT COUNT(*) FROM sales WHERE total < 0) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM sales WHERE total<0)::text || ' venda(s) com total negativo'
    END,
    'Dados financeiros corrompidos'

  UNION ALL

  -- T30: Nenhum stock_movement com new_stock negativo
  SELECT
    'T30',
    'Nenhum stock_movement resultou em new_stock negativo',
    CASE
      WHEN (SELECT COUNT(*) FROM stock_movements WHERE new_stock < 0) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM stock_movements WHERE new_stock<0)::text || ' movimento(s) geraram saldo negativo'
    END,
    'Sinal de race condition ou falha de validação no passado'

  UNION ALL

  -- T31: Nenhum cliente sem company_id
  SELECT
    'T31',
    'Nenhum cliente sem company_id',
    CASE
      WHEN (SELECT COUNT(*) FROM customers WHERE company_id IS NULL) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM customers WHERE company_id IS NULL)::text || ' cliente(s) sem empresa associada'
    END,
    'Dados de clientes visíveis entre empresas (falha de multi-tenant)'

  UNION ALL

  -- T32: Nenhum registro de stock sem company_id
  SELECT
    'T32',
    'Nenhum registro de stock sem company_id',
    CASE
      WHEN (SELECT COUNT(*) FROM stock WHERE company_id IS NULL) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (SELECT COUNT(*) FROM stock WHERE company_id IS NULL)::text || ' registro(s) de stock sem empresa'
    END,
    'Estoque pode vazar entre empresas se RLS não filtrar corretamente'

  UNION ALL

  -- T33: Cashback config tem exatamente uma configuração ativa
  SELECT
    'T33',
    'Cashback tem exatamente 1 configuração ativa por empresa',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename='cashback_config' AND schemaname='public')
        THEN '⚠ ATENÇÃO — tabela cashback_config não encontrada'
      WHEN (SELECT COUNT(*) FROM cashback_config WHERE active=true) = 0
        THEN '⚠ ATENÇÃO — nenhuma config de cashback ativa (cashback desabilitado)'
      WHEN (SELECT COUNT(*) FROM cashback_config WHERE active=true) = 1
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM cashback_config WHERE active=true)::text || ' configs ativas (deveria ser 1)'
    END,
    'Cashback pode ser calculado com taxa errada'

  UNION ALL

  -- T34: Nenhuma movimentação de estoque órfã (sem product_id)
  SELECT
    'T34',
    'Nenhuma movimentação de estoque sem product_id',
    CASE
      WHEN (SELECT COUNT(*) FROM stock_movements WHERE product_id IS NULL) = 0
        THEN '✓ PASSOU'
      ELSE '⚠ ATENÇÃO — ' || (SELECT COUNT(*) FROM stock_movements WHERE product_id IS NULL)::text || ' movimentação(ões) sem product_id'
    END,
    'Relatórios por produto perdem dados'

  UNION ALL

  -- T35: Nenhum lote de estoque com quantity_remaining > quantity_original
  SELECT
    'T35',
    'Nenhum lote com quantity_remaining > quantity_original (impossível)',
    CASE
      WHEN (SELECT COUNT(*) FROM stock_lots WHERE quantity_remaining > quantity_original) = 0
        THEN '✓ PASSOU'
      ELSE '✗ FALHOU — ' || (SELECT COUNT(*) FROM stock_lots WHERE quantity_remaining>quantity_original)::text || ' lote(s) com quantidade inconsistente'
    END,
    'Dados de lote corrompidos'

)
SELECT id, descricao, resultado, impacto_se_falhar FROM resultados ORDER BY id;

-- =============================================================================
-- RESUMO FINAL
-- =============================================================================

SELECT '=== RESUMO DOS TESTES ===' AS titulo;

WITH todos_testes AS (
  -- Bloco 1
  SELECT 'T01' AS id, CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace) THEN 'FALHOU' WHEN pg_get_viewdef('public.mv_stock_status'::regclass,true) ILIKE '%stock_lots%' THEN 'FALHOU' ELSE 'PASSOU' END AS status
  UNION ALL SELECT 'T02', CASE WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace AND relkind='m') THEN 'ATENÇÃO' WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname='mv_stock_status' AND relnamespace='public'::regnamespace AND relkind='v') THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T06', CASE WHEN EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_schema='public' AND trigger_name='trg_prevent_direct_stock_write' AND event_object_table='stock') THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T07', CASE WHEN (SELECT COUNT(*) FROM (VALUES ('rpc_create_sale'),('rpc_cancel_sale'),('rpc_return_sale'),('rpc_stock_entry'),('rpc_stock_adjust'),('rpc_stock_initialize')) AS t(fn) WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=t.fn)) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T09', CASE WHEN (SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('stock','sales','customers','finance_entries','stock_movements') AND rowsecurity=false) = 0 THEN 'PASSOU' ELSE 'ATENÇÃO' END
  UNION ALL SELECT 'T12', CASE WHEN (SELECT COUNT(*) FROM stock WHERE quantity<0) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T13', CASE WHEN (SELECT COUNT(*) FROM product_variations pv WHERE pv.active=true AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.product_variation_id=pv.id)) = 0 THEN 'PASSOU' ELSE 'ATENÇÃO' END
  UNION ALL SELECT 'T14', CASE WHEN (SELECT COUNT(*) FROM (SELECT s.product_variation_id FROM stock s LEFT JOIN stock_movements sm ON sm.product_variation_id=s.product_variation_id GROUP BY s.product_variation_id, s.quantity HAVING s.quantity != COALESCE(SUM(sm.quantity),0)) t) = 0 THEN 'PASSOU' ELSE 'ATENÇÃO' END
  UNION ALL SELECT 'T15', CASE WHEN (SELECT COUNT(*) FROM sales s WHERE s.status='paid' AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.reference_id=s.id::text AND sm.type='sale')) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T16', CASE WHEN (SELECT COUNT(*) FROM sales s WHERE s.status IN ('cancelled','returned') AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.reference_id=s.id::text AND sm.type='return')) = 0 THEN 'PASSOU' ELSE 'ATENÇÃO' END
  UNION ALL SELECT 'T17', CASE WHEN (SELECT COUNT(*) FROM sales s WHERE s.status='paid' AND NOT EXISTS (SELECT 1 FROM finance_entries fe WHERE fe.sale_id=s.id AND fe.type='income' AND fe.category='sale')) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T19', CASE WHEN (SELECT COUNT(*) FROM (SELECT sale_number FROM sales GROUP BY sale_number HAVING COUNT(*)>1) t) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T20', CASE WHEN (SELECT COUNT(*) FROM (SELECT sku_variation FROM product_variations GROUP BY sku_variation HAVING COUNT(*)>1) t) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T22', CASE WHEN (SELECT COUNT(*) FROM pedidos WHERE stock_processed=true AND sale_id IS NULL) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T28', CASE WHEN (SELECT COUNT(*) FROM products WHERE active=true AND base_price<=0) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T29', CASE WHEN (SELECT COUNT(*) FROM sales WHERE total<0) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T30', CASE WHEN (SELECT COUNT(*) FROM stock_movements WHERE new_stock<0) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
  UNION ALL SELECT 'T31', CASE WHEN (SELECT COUNT(*) FROM customers WHERE company_id IS NULL) = 0 THEN 'PASSOU' ELSE 'FALHOU' END
)
SELECT
  COUNT(*) FILTER (WHERE status='PASSOU')  AS testes_passaram,
  COUNT(*) FILTER (WHERE status='ATENÇÃO') AS testes_atencao,
  COUNT(*) FILTER (WHERE status='FALHOU')  AS testes_falharam,
  COUNT(*)                                  AS total_testes,
  CASE
    WHEN COUNT(*) FILTER (WHERE status='FALHOU') = 0
     AND COUNT(*) FILTER (WHERE status='ATENÇÃO') = 0
      THEN '🟢 BANCO PRONTO PARA LANÇAMENTO'
    WHEN COUNT(*) FILTER (WHERE status='FALHOU') = 0
      THEN '🟡 BANCO COM ALERTAS — revisar itens ATENÇÃO antes do lançamento'
    ELSE '🔴 BANCO COM FALHAS CRÍTICAS — corrigir antes do lançamento'
  END AS veredicto
FROM todos_testes;

-- =============================================================================
-- FIM DOS TESTES
-- =============================================================================
