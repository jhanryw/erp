#!/usr/bin/env bash
# =============================================================================
# mercadolivre_oauth.concurrency.sh — lease de refresh com DUAS sessões reais.
#   Sessão 1 adquire o lease dentro de uma transação e segura 2s.
#   Sessão 2 tenta ao mesmo tempo: bloqueia na linha, e ao prosseguir vê o
#   lease já ocupado → claimed=false. Nunca dois donos do refresh_token.
# Deixa dados commitados numa empresa de teste — rode SÓ em banco de TESTE.
#   DATABASE_URL=postgres://... bash supabase/tests/mercadolivre_oauth.concurrency.sh
# =============================================================================
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL (banco de TESTE)}"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA)
TAG="mlconc-$(date +%s)-$$"

read -r COMPANY INTEGRATION <<<"$("${PSQL[@]}" -c "
  WITH c AS (INSERT INTO companies (name, slug) VALUES ('TESTE ML CONC', '$TAG') RETURNING id),
       u AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id)
  SELECT c.id, (rpc_upsert_oauth_integration(c.id, 'mercadolivre', '$TAG', '{}'::jsonb, 'a', 'r', 1,
         NOW() - interval '1 minute', NULL, u.id)->>'integration_id')
  FROM c, u" | tr '|' ' ')"

out1=$(mktemp); out2=$(mktemp)
( "${PSQL[@]}" >"$out1" <<SQL
BEGIN;
SELECT rpc_claim_integration_token_refresh($INTEGRATION, $COMPANY, 'worker-1', 60)->>'claimed';
SELECT pg_sleep(2);
COMMIT;
SQL
) & p1=$!
sleep 0.5
( "${PSQL[@]}" -c "SELECT rpc_claim_integration_token_refresh($INTEGRATION, $COMPANY, 'worker-2', 60)->>'claimed'" >"$out2" ) & p2=$!
wait $p1; wait $p2

c1=$(grep -E '^(true|false)$' "$out1" | head -1); c2=$(grep -E '^(true|false)$' "$out2" | head -1)
owner=$("${PSQL[@]}" -c "SELECT refresh_lease_owner FROM company_integrations WHERE id=$INTEGRATION")
rm -f "$out1" "$out2"

[ "$c1" = "true" ]  || { echo "FALHOU: worker-1 deveria ganhar (obteve $c1)"; exit 1; }
[ "$c2" = "false" ] || { echo "FALHOU: worker-2 não pode ganhar lease ocupado (obteve $c2)"; exit 1; }
[ "$owner" = "worker-1" ] || { echo "FALHOU: dono do lease deveria ser worker-1 (obteve $owner)"; exit 1; }
echo "ok  worker-1 claimed=true, worker-2 claimed=false (bloqueou e respeitou o lease), dono=worker-1"
echo "mercadolivre_oauth.concurrency: OK"
