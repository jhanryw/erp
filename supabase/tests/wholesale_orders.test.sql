-- =============================================================================
-- Testes SQL manuais — 20260921_wholesale_orders.sql (rpc_create_wholesale_order)
--
-- Rodar em um banco de TESTE já com a migration aplicada (cria/limpa dados
-- fictícios; NÃO rodar em produção):
--   psql "$DATABASE_URL" -f supabase/tests/wholesale_orders.test.sql
-- Cada teste faz RAISE EXCEPTION se falhar. Precisa de companies (1, 2) e de
-- product_variations/products só se os ids forem preenchidos (aqui vão NULL).
-- Concorrência real (N conexões simultâneas) não cabe num único script — ver
-- o comando de xargs -P no relatório da fase.
-- =============================================================================

BEGIN;

DELETE FROM public.wholesale_order_items;
DELETE FROM public.wholesale_orders;
DELETE FROM public.wholesale_order_counters;

CREATE TEMP TABLE _r (name text, res jsonb);

-- Item padrão: 2 un. × 150,00 = 300,00
\set item '[{"variation_id":null,"product_id":null,"product_name":"Conjunto Nuance","sku":"NUA-M-PRETO","attributes":[{"type":"Tamanho","value":"M"}],"quantity":2,"unit_price":150.00}]'

-- 1. criação válida → AT-000001
INSERT INTO _r SELECT 'create', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000001', 'Maria Silva', '+5584999999999', 300, 'iphash', :'item'::jsonb);
DO $$ DECLARE r jsonb := (SELECT res FROM _r WHERE name='create'); BEGIN
  IF NOT (r->>'ok')::bool OR r->>'code' <> 'AT-000001' OR (r->>'replay')::bool THEN RAISE EXCEPTION 'criação válida falhou: %', r; END IF;
END $$;

-- 2. idempotência: mesma chave → mesmo pedido, sem novo registro nem novo número
INSERT INTO _r SELECT 'replay', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000001', 'Maria Silva', '+5584999999999', 300, 'iphash', :'item'::jsonb);
DO $$ DECLARE r jsonb := (SELECT res FROM _r WHERE name='replay'); BEGIN
  IF r->>'code' <> 'AT-000001' OR NOT (r->>'replay')::bool THEN RAISE EXCEPTION 'replay falhou: %', r; END IF;
  IF (SELECT count(*) FROM public.wholesale_orders) <> 1 THEN RAISE EXCEPTION 'replay criou pedido duplicado'; END IF;
END $$;

-- 3. abaixo do mínimo → rejeitado e o contador NÃO avança
INSERT INTO _r SELECT 'below', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000002', 'Maria Silva', '+5584999999999', 500, 'iphash', :'item'::jsonb);
DO $$ DECLARE r jsonb := (SELECT res FROM _r WHERE name='below'); BEGIN
  IF (r->>'ok')::bool OR r->>'error' <> 'below_minimum' THEN RAISE EXCEPTION 'below_minimum falhou: %', r; END IF;
  IF (SELECT last_number FROM public.wholesale_order_counters WHERE company_id=1) <> 1 THEN RAISE EXCEPTION 'contador avançou em rejeição'; END IF;
END $$;

-- 4. atomicidade: item inválido (quantity 0) derruba TUDO (pedido + contador)
DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000003', 'Maria Silva', '+5584999999999', 0, 'iphash',
      '[{"product_name":"A","sku":"A","attributes":[],"quantity":1,"unit_price":10},{"product_name":"B","sku":"B","attributes":[],"quantity":0,"unit_price":10}]'::jsonb);
    RAISE EXCEPTION 'deveria ter falhado';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT count(*) FROM public.wholesale_orders WHERE idempotency_key='00000000-0000-0000-0000-000000000003') <> 0 THEN RAISE EXCEPTION 'pedido parcial ficou gravado'; END IF;
  IF (SELECT last_number FROM public.wholesale_order_counters WHERE company_id=1) <> 1 THEN RAISE EXCEPTION 'contador avançou após falha'; END IF;
END $$;

-- 5. chave diferente → novo pedido, próximo número sem buraco
INSERT INTO _r SELECT 'second', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000004', 'João', '+5584988887777', 300, 'other', :'item'::jsonb);
DO $$ BEGIN
  IF (SELECT res->>'code' FROM _r WHERE name='second') <> 'AT-000002' THEN RAISE EXCEPTION 'sequência com buraco'; END IF;
END $$;

-- 6. totais recalculados dos itens (e snapshot preservado)
DO $$ BEGIN
  IF (SELECT subtotal FROM public.wholesale_orders WHERE code='AT-000001') <> 300.00 OR (SELECT total_items FROM public.wholesale_orders WHERE code='AT-000001') <> 2 THEN RAISE EXCEPTION 'totais errados'; END IF;
  IF (SELECT sku FROM public.wholesale_order_items WHERE order_id=(SELECT id FROM public.wholesale_orders WHERE code='AT-000001')) <> 'NUA-M-PRETO' THEN RAISE EXCEPTION 'snapshot errado'; END IF;
END $$;

-- 7. limite por telefone (2/hora) → terceiro pedido do mesmo telefone é bloqueado
INSERT INTO _r SELECT 'rl1', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000010', 'Ana', '+5584911112222', 300, 'ip-a', :'item'::jsonb, 30, 2);
INSERT INTO _r SELECT 'rl2', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000011', 'Ana', '+5584911112222', 300, 'ip-b', :'item'::jsonb, 30, 2);
INSERT INTO _r SELECT 'rl3', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000012', 'Ana', '+5584911112222', 300, 'ip-c', :'item'::jsonb, 30, 2);
DO $$ BEGIN
  IF (SELECT res->>'error' FROM _r WHERE name='rl3') <> 'rate_limited' THEN RAISE EXCEPTION 'rate limit por telefone falhou'; END IF;
END $$;

-- 8. empresas isoladas: contador próprio e mesma chave em outra empresa não colide
INSERT INTO _r SELECT 'co2', public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000001', 'Carla', '+5511977776666', 300, 'ip-z', :'item'::jsonb);
DO $$ BEGIN
  IF (SELECT res->>'code' FROM _r WHERE name='co2') <> 'AT-000001' OR (SELECT (res->>'replay')::bool FROM _r WHERE name='co2') THEN RAISE EXCEPTION 'isolamento por empresa falhou'; END IF;
END $$;

-- 8b. teto GLOBAL por empresa (independe de IP e telefone): 3º pedido de IP/telefone novos é bloqueado
INSERT INTO _r SELECT 'g1', public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000021', 'G1', '+5511911110001', 300, 'g-ip-1', :'item'::jsonb, 1000, 1000, 2);
INSERT INTO _r SELECT 'g2', public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000022', 'G2', '+5511911110002', 300, 'g-ip-2', :'item'::jsonb, 1000, 1000, 2);
INSERT INTO _r SELECT 'g3', public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000023', 'G3', '+5511911110003', 300, 'g-ip-3', :'item'::jsonb, 1000, 1000, 2);
DO $$ BEGIN
  IF (SELECT res->>'error' FROM _r WHERE name='g3') IS DISTINCT FROM 'rate_limited' THEN RAISE EXCEPTION 'teto global falhou'; END IF;
END $$;

-- 9. constraints: código único por empresa
DO $$ BEGIN
  BEGIN
    INSERT INTO public.wholesale_orders (company_id, order_number, code, customer_name, customer_phone, total_items, subtotal, minimum_order_amount, idempotency_key)
    VALUES (1, 999, 'AT-000001', 'Dup', '+5584999999999', 1, 300, 300, gen_random_uuid());
    RAISE EXCEPTION 'código duplicado aceito';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

-- ─── Contato opcional (migration 202610131000_wholesale_orders_optional_contact) ───────────────
-- 10. pedido SEM contato (NULL/NULL) é aceito e gravado com NULL
INSERT INTO _r SELECT 'anon1', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000031', NULL, NULL, 300, 'anon-ip-1', :'item'::jsonb);
DO $$ DECLARE r jsonb := (SELECT res FROM _r WHERE name='anon1'); BEGIN
  IF NOT (r->>'ok')::bool THEN RAISE EXCEPTION 'pedido anônimo falhou: %', r; END IF;
  IF (SELECT customer_name FROM public.wholesale_orders WHERE idempotency_key='00000000-0000-0000-0000-000000000031') IS NOT NULL
     OR (SELECT customer_phone FROM public.wholesale_orders WHERE idempotency_key='00000000-0000-0000-0000-000000000031') IS NOT NULL
  THEN RAISE EXCEPTION 'contato anônimo não ficou NULL'; END IF;
END $$;

-- 10b. idempotência do pedido anônimo
INSERT INTO _r SELECT 'anon1r', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000031', NULL, NULL, 300, 'anon-ip-1', :'item'::jsonb);
DO $$ BEGIN
  IF NOT (SELECT (res->>'replay')::bool FROM _r WHERE name='anon1r') THEN RAISE EXCEPTION 'replay anônimo falhou'; END IF;
  IF (SELECT count(*) FROM public.wholesale_orders WHERE idempotency_key='00000000-0000-0000-0000-000000000031') <> 1 THEN RAISE EXCEPTION 'pedido anônimo duplicado'; END IF;
END $$;

-- 11. NULL nunca é agrupado pelo limite por telefone (2/h): 3 anônimos de IPs distintos passam
INSERT INTO _r SELECT 'an_a', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000032', NULL, NULL, 300, 'an-ip-a', :'item'::jsonb, 30, 2);
INSERT INTO _r SELECT 'an_b', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000033', NULL, NULL, 300, 'an-ip-b', :'item'::jsonb, 30, 2);
INSERT INTO _r SELECT 'an_c', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000034', NULL, NULL, 300, 'an-ip-c', :'item'::jsonb, 30, 2);
DO $$ BEGIN
  IF (SELECT count(*) FROM _r WHERE name IN ('an_a','an_b','an_c') AND (res->>'ok')::bool) <> 3 THEN RAISE EXCEPTION 'anônimos foram agrupados por telefone NULL'; END IF;
END $$;

-- 11b. o limite por IP continua valendo para anônimos (2/h por hash de IP)
INSERT INTO _r SELECT 'ip1', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000041', NULL, NULL, 300, 'same-ip', :'item'::jsonb, 2, 10);
INSERT INTO _r SELECT 'ip2', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000042', NULL, NULL, 300, 'same-ip', :'item'::jsonb, 2, 10);
INSERT INTO _r SELECT 'ip3', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000043', NULL, NULL, 300, 'same-ip', :'item'::jsonb, 2, 10);
DO $$ BEGIN
  IF (SELECT res->>'error' FROM _r WHERE name='ip3') IS DISTINCT FROM 'rate_limited' THEN RAISE EXCEPTION 'limite por IP não vale para anônimo'; END IF;
END $$;

-- 11c. o teto por empresa continua valendo para anônimos SEM IP (p_request_ip_hash NULL):
--      com teto = (pedidos da empresa agora) + 1, o primeiro passa e o seguinte é bloqueado
DO $$ DECLARE n int; r1 jsonb; r2 jsonb; BEGIN
  SELECT count(*) INTO n FROM public.wholesale_orders WHERE company_id = 2 AND created_at > NOW() - INTERVAL '1 hour';
  r1 := public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000051', NULL, NULL, 300, NULL,
        '[{"product_name":"A","sku":"A","attributes":[],"quantity":2,"unit_price":150}]'::jsonb, 1000, 1000, n + 1);
  r2 := public.rpc_create_wholesale_order(2, '00000000-0000-0000-0000-000000000052', NULL, NULL, 300, NULL,
        '[{"product_name":"A","sku":"A","attributes":[],"quantity":2,"unit_price":150}]'::jsonb, 1000, 1000, n + 1);
  IF NOT (r1->>'ok')::bool THEN RAISE EXCEPTION 'anônimo sem IP deveria passar abaixo do teto: %', r1; END IF;
  IF r2->>'error' IS DISTINCT FROM 'rate_limited' THEN RAISE EXCEPTION 'teto por empresa não vale para anônimo sem IP: %', r2; END IF;
END $$;

-- 12. só um dos dois campos de contato → recusado pela RPC e pelo CHECK
INSERT INTO _r SELECT 'half', public.rpc_create_wholesale_order(1, '00000000-0000-0000-0000-000000000061', 'Só nome', NULL, 300, 'half-ip', :'item'::jsonb);
DO $$ BEGIN
  IF (SELECT res->>'error' FROM _r WHERE name='half') IS DISTINCT FROM 'invalid_contact' THEN RAISE EXCEPTION 'contato pela metade aceito pela RPC'; END IF;
  BEGIN
    INSERT INTO public.wholesale_orders (company_id, order_number, code, customer_name, customer_phone, total_items, subtotal, minimum_order_amount, idempotency_key)
    VALUES (1, 998, 'AT-998', 'Só nome', NULL, 1, 300, 300, gen_random_uuid());
    RAISE EXCEPTION 'CHECK de par aceitou contato pela metade';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- 13. formato do telefone INFORMADO continua validado (o CHECK E.164 segue valendo)
DO $$ BEGIN
  BEGIN
    INSERT INTO public.wholesale_orders (company_id, order_number, code, customer_name, customer_phone, total_items, subtotal, minimum_order_amount, idempotency_key)
    VALUES (1, 997, 'AT-997', 'Fulano', '999', 1, 300, 300, gen_random_uuid());
    RAISE EXCEPTION 'telefone inválido aceito';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- 14. backfill: marcador fictício da estratégia anterior vira NULL/NULL; pedido com contato real NÃO é tocado
INSERT INTO public.wholesale_orders (company_id, order_number, code, customer_name, customer_phone, total_items, subtotal, minimum_order_amount, idempotency_key)
VALUES (1, 990, 'AT-990', 'Cliente do site', '+550012345678', 1, 300, 300, gen_random_uuid()),
       (1, 991, 'AT-991', 'Cliente do site', '+5584999999999', 1, 300, 300, gen_random_uuid());
UPDATE public.wholesale_orders SET customer_name = NULL, customer_phone = NULL
 WHERE customer_name = 'Cliente do site' AND customer_phone ~ '^\+5500[0-9]{8}$';
DO $$ BEGIN
  IF (SELECT customer_phone FROM public.wholesale_orders WHERE code='AT-990') IS NOT NULL THEN RAISE EXCEPTION 'backfill não limpou o marcador'; END IF;
  IF (SELECT customer_phone FROM public.wholesale_orders WHERE code='AT-991') IS DISTINCT FROM '+5584999999999' THEN RAISE EXCEPTION 'backfill tocou pedido real'; END IF;
END $$;

ROLLBACK;  -- nada fica no banco de teste
SELECT 'wholesale_orders SQL tests: OK' AS resultado;
