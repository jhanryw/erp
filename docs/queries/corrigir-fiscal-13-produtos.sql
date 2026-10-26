-- =============================================================================
-- CORREÇÃO ATÔMICA — NCM e origem fiscal dos produtos 850..862 (company_id = 1)
-- CSV de origem: "template-importacao - MB e ClickC out_26 (1).csv"
-- Rodar INTEIRO, de uma vez, no SQL Editor do Supabase de produção.
--  * Só altera as colunas ncm e origem, e só onde estão NULL (valor existente é preservado).
--  * Aborta (nada é gravado) se algum dos 13 produtos não existir, não for da empresa 1
--    ou tiver nome diferente do esperado, ou se o resultado final não estiver completo.
--  * Pode ser repetido: na 2ª execução nenhuma linha é alterada (0 atualizados).
--  * Efeito colateral inevitável: o trigger set_updated_at atualiza products.updated_at
--    nas linhas realmente alteradas.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_total    int;
  v_ok       int;
  v_updated  int;
  v_pendente int;
BEGIN
  CREATE TEMP TABLE _esperado (id int PRIMARY KEY, nome text NOT NULL, ncm text NOT NULL, origem smallint NOT NULL) ON COMMIT DROP;
  INSERT INTO _esperado (id, nome, ncm, origem) VALUES
    (850, 'Conjunto Cropped SX Preto',            '62121000', 0),
    (851, 'Conjunto Cropped SX Branco',           '62121000', 0),
    (852, 'Conjunto Cropped SX Vermelho',         '62121000', 0),
    (853, 'Calcinha Avulsa de Renda Verde Água',  '61082200', 0),
    (854, 'Calcinha Avulsa de Renda Vermelho',    '61082200', 0),
    (855, 'Calcinha Avulsa de Renda Preto',       '61082200', 0),
    (856, 'Calcinha Avulsa de Renda Amarelo',     '61082200', 0),
    (857, 'Calcinha Cotton Preto',                '61082100', 0),
    (858, 'Calcinha Cotton Azul Marinho',         '61082100', 0),
    (859, 'Calcinha Cotton Branco',               '61082100', 0),
    (860, 'Calcinha Cotton Rosê',                 '61082100', 0),
    (861, 'Conjunto Tule Bordado Marrom',         '62121000', 0),
    (862, 'Sutiã Tule Bordado Preto',             '62121000', 0);

  -- 1) identidade: os 13 existem, são da empresa 1 e têm exatamente o nome esperado
  SELECT count(*) INTO v_ok
  FROM _esperado e JOIN public.products p ON p.id = e.id AND p.company_id = 1 AND p.name = e.nome;
  IF v_ok <> 13 THEN
    RAISE EXCEPTION 'ABORTADO: apenas % de 13 produtos correspondem (id + company_id=1 + nome). Nada foi alterado.', v_ok;
  END IF;

  -- 2) atualiza SOMENTE ncm/origem NULL (ou NCM vazio) dos 13 ids
  UPDATE public.products p
  SET ncm    = CASE WHEN p.ncm IS NULL OR btrim(p.ncm) = '' THEN e.ncm ELSE p.ncm END,
      origem = COALESCE(p.origem, e.origem)
  FROM _esperado e
  WHERE p.id = e.id AND p.company_id = 1
    AND (p.ncm IS NULL OR btrim(p.ncm) = '' OR p.origem IS NULL);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 13 THEN
    RAISE EXCEPTION 'ABORTADO: % linhas atualizadas (máximo esperado 13).', v_updated;
  END IF;

  -- 3) validação final: todos preenchidos, NCM no formato e origem no intervalo
  SELECT count(*) INTO v_pendente
  FROM _esperado e JOIN public.products p ON p.id = e.id AND p.company_id = 1
  WHERE p.ncm IS NULL OR p.ncm !~ '^\d{8}$' OR p.origem IS NULL OR p.origem NOT BETWEEN 0 AND 8;
  IF v_pendente > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % produtos ficariam sem NCM/origem válidos. Nada foi alterado.', v_pendente;
  END IF;

  -- 4) valores que já existiam e eram diferentes do CSV foram preservados: apenas avisa
  SELECT count(*) INTO v_total
  FROM _esperado e JOIN public.products p ON p.id = e.id
  WHERE p.ncm <> e.ncm OR p.origem <> e.origem;
  IF v_total > 0 THEN
    RAISE NOTICE '% produto(s) já tinham NCM/origem diferente do CSV; foram preservados (não alterados).', v_total;
  END IF;

  RAISE NOTICE 'OK: % produto(s) atualizado(s) nesta execução (0 = já estava correto).', v_updated;
END $$;

COMMIT;

-- Resultado final (após o COMMIT)
SELECT id, name, ncm, origem
FROM public.products
WHERE company_id = 1 AND id BETWEEN 850 AND 862
ORDER BY id;
