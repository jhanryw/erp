-- Media Hub — Fase 2: troca atômica de mídia principal (role='primary').
--
-- Substitui o padrão manual (DELETE + INSERT via duas chamadas JS separadas)
-- por uma única transação Postgres: nenhuma leitura concorrente observa a
-- entidade sem primary nenhuma, e qualquer falha desfaz tudo junto.
--
-- Posse da entidade (product/product_variation/shipment) continua validada
-- na service layer via entityBelongsToCompany() antes de chamar este RPC —
-- não duplicado aqui de propósito (evita reimplementar em PL/pgSQL um
-- dispatch de 3 caminhos de join já escrito e testado em TypeScript).

CREATE OR REPLACE FUNCTION public.rpc_set_primary_media(
  p_user_id     uuid,
  p_media_id    bigint,
  p_entity_type text,
  p_entity_id   text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company_id     int;
  v_media_company  int;
  v_media_active   boolean;
  v_old_usage_id   bigint;
  v_old_media_id   bigint;
  v_new_usage_id   bigint;
  v_created_at     timestamptz;
BEGIN
  IF p_entity_type NOT IN ('product', 'product_variation', 'shipment') THEN
    RAISE EXCEPTION 'entity_type inválido: %.', p_entity_type USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id, active INTO v_media_company, v_media_active
  FROM media WHERE id = p_media_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mídia não encontrada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_media_company != v_company_id THEN
    RAISE EXCEPTION 'Mídia não pertence à empresa do usuário.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_media_active THEN
    RAISE EXCEPTION 'Mídia inativa não pode ser definida como principal.' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM media_usages
  WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND role = 'primary'
  RETURNING id, media_id INTO v_old_usage_id, v_old_media_id;

  INSERT INTO media_usages (media_id, entity_type, entity_id, role, position, company_id, created_by)
  VALUES (p_media_id, p_entity_type, p_entity_id, 'primary', 0, v_company_id, p_user_id)
  RETURNING id, created_at INTO v_new_usage_id, v_created_at;

  RETURN jsonb_build_object(
    'usage_id', v_new_usage_id,
    'media_id', p_media_id,
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'position', 0,
    'created_at', v_created_at,
    'previous_usage_id', v_old_usage_id,
    'previous_media_id', v_old_media_id
  );
END;
$$;
