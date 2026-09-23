# Mercado Livre — Fase 1: OAuth e conta conectada (2026-09-24)

Escopo: conexão segura de UMA conta de vendedor Mercado Livre por empresa Qarvon, com tokens cifrados, refresh seguro sob concorrência, revalidação, desconexão e ferramenta restrita de usuário TEST. **Sem** anúncios, estoque, pedidos, webhooks, envios ou fiscal.

Documentação oficial consultada (developers.mercadolivre.com.br): *Autenticação e Autorização* (29/12/2025), *Realização de testes* (30/12/2025), *Recomendações de Autenticação e Token* (30/12/2025), *Gerencie seu aplicativo* (06/08/2026 — **a partir de 30/08/2026 apps precisam ser separados entre Mercado Livre e Mercado Pago**).

## Reauditoria

Nada foi reconstruído. `company_integrations`, `integration_secrets`, `external_entity_links`, `integration_outbox`, deliveries, runner e `secretCipher` estavam intactos; desde a auditoria só o CHECK de provider ganhou `focus_nfe`/`fiscal_certificate` (202609051100). O módulo de kits não tocou essas estruturas. Padrão reaproveitado do Chatwoot: resolução de empresa por integração, segredos só via `secrets.service`, logs sem PII. Nuvemshop **não** foi usada como modelo (token no callback, single-tenant por env).

## Migration

`supabase/migrations/202609241000_mercadolivre_oauth_foundation.sql` — aditiva, idempotente (aplicada 2× sem erro):

- `company_integrations.provider` + `mercadolivre`; `status` + `needs_reauth`.
- Colunas **não secretas** e genéricas (servem a Shopee/Amazon): `credential_expires_at`, `oauth_scopes`, `credential_refreshed_at`, `last_validated_at`, `connected_at`, `disconnected_at`, `refresh_lease_until`, `refresh_lease_owner`. (Nenhuma coluna com "token/secret" no nome — invariante já testada por `company_integrations_and_external_links.test.sql`.)
- `integration_oauth_states`: state OAuth **só como hash sha256**, vinculado a `company_id` + `user_id` + `expires_at` (10 min), uso único, `code_verifier` PKCE cifrado.
- RPCs (service_role apenas): `rpc_consume_oauth_state`, `rpc_upsert_oauth_integration`, `rpc_claim_integration_token_refresh`, `rpc_complete_integration_token_refresh`, `rpc_fail_integration_token_refresh`, `rpc_disconnect_oauth_integration`.
- `UNIQUE(provider, external_account_id)` preservado: a mesma conta ML nunca fica em duas empresas.

## Estados

| status (banco) | na tela | significado |
|---|---|---|
| `active` | Conectado | tokens válidos/renováveis |
| `inactive` | Desconectado | desligado pelo usuário (tokens apagados, registro preservado) |
| `needs_reauth` | Reautorização necessária | `invalid_grant` — revogado, senha trocada, expirado; sem retry automático |
| `error` | Erro | falha operacional (não é revogação) |
| — | Não configurada | faltam CLIENT_ID/SECRET/REDIRECT_URI no servidor |

## Arquivos

**Criados**
- `src/lib/integrations/mercadolivre/`: `config.ts`, `errors.ts`, `log.ts`, `http.ts`, `oauth.ts`, `tokens.ts`, `client.ts`, `users.ts`, `types.ts`, `fakeMercadoLivre.testutil.ts`, `oauth-http.test.ts`, `tokens-client.test.ts`
- `src/services/integrations/mercadolivre.service.ts` (+ `.test.ts`)
- `src/app/api/integrations/mercadolivre/{_shared.ts, connect, callback, status, revalidate, refresh, disconnect}/route.ts` (+ `routes.test.ts`)
- `src/app/api/jobs/mercadolivre/refresh-tokens/route.ts`
- `src/app/(dashboard)/configuracoes/mercadolivre/{page.tsx, MercadoLivreIntegration.tsx}`
- `scripts/mercadolivre-test-user.mjs`
- `supabase/tests/mercadolivre_oauth.test.sql`, `supabase/tests/mercadolivre_oauth.concurrency.sh`

**Alterados**: `src/services/integrations/company-integrations.service.ts` (tipos provider/status), `src/lib/audit/log.ts` (recurso `company_integration`), `src/app/(dashboard)/configuracoes/page.tsx` (card Mercado Livre), `.env.example`.

## Endpoints (todos exigem sessão **admin** da empresa — mesmo nível de Nuvemshop/Fiscal)

| Método | Rota | Função |
|---|---|---|
| GET | `/api/integrations/mercadolivre/connect` | inicia OAuth (state+PKCE) → 303 para o ML |
| GET | `/api/integrations/mercadolivre/callback` | redirect_uri fixa; valida state × sessão, troca code, `/users/me`, grava; 303 para a tela **sem code/token na URL** (`Referrer-Policy: no-referrer`) |
| GET | `/api/integrations/mercadolivre/status` | view não sensível |
| POST | `/api/integrations/mercadolivre/revalidate` | `/users/me` pela integração |
| POST | `/api/integrations/mercadolivre/refresh` | força renovação (homologação) |
| POST | `/api/integrations/mercadolivre/disconnect` | revoga no ML (melhor esforço), apaga tokens, preserva registro |
| POST | `/api/jobs/mercadolivre/refresh-tokens` | CRON_SECRET; renova tokens que vencem na próxima hora |

## Modelo de segurança

- **Dois níveis de credencial**: app Qarvon (CLIENT_ID/SECRET/REDIRECT_URI) só em env do servidor; tokens de cada empresa só em `integration_secrets` (AES-256-GCM, `key_version`). Nunca em settings, URL, JSON de resposta, logs, cookies ou storage do navegador.
- **State**: 256 bits aleatórios, persistido só como hash, uso único, TTL 10 min, amarrado a empresa **e** usuário; callback de outra empresa/usuário é recusado. Identidade da empresa nunca na redirect_uri.
- **PKCE S256** (configurável por `MERCADOLIVRE_USE_PKCE`, deve espelhar o DevCenter).
- **Token no header** `Authorization: Bearer` (nunca query); `/oauth/token` com parâmetros no corpo.
- **Multi-tenant**: company_id sempre da sessão; toda leitura/escrita de integração, segredo, lease e desconexão filtra por `company_id` no banco (RPCs incluídas). Testes de crossover no TS e no SQL.
- **Logs**: `logMercadoLivre` só aceita campos de uma allowlist (company/integration/seller/user/http_status/request_id/worker/reason/path/duração) e redige padrões `APP_USR-…`, `TG-…`, `Bearer …`, `code=`, `client_secret=`. Eventos: `mercadolivre.oauth.started|completed|failed`, `token.refreshed|refresh_failed|refresh_waited`, `integration.validated|disconnected`, `api.error`.
- **Dados da conta persistidos**: seller_id, nickname, site_id, country_id, permalink, is_test_user. Nada de e-mail/documento/endereço.

## Estratégia de refresh (crítica)

O refresh_token do ML é de uso único e só o último vale. Como o refresh exige HTTP, e o Next.js fala com o Postgres via PostgREST (uma transação por RPC), não dá para segurar advisory lock/`FOR UPDATE` durante o HTTP. Usa-se **lease com fencing** (mesmo padrão do claim fiscal):

1. token com >5 min de validade → usa.
2. vencido → `rpc_claim_integration_token_refresh` (UPDATE atômico, lease 60s). Só um worker ganha.
3. vencedor: double-check sob lease → relê o refresh_token **atual** → `POST /oauth/token` (timeout 15s) → `rpc_complete_…` grava par novo + expiração + libera lease **só se ainda for o dono**.
4. perdedores: aguardam (poll 250 ms, até 20 s) e reutilizam o token **novo** — nunca o refresh_token rotacionado.
5. `invalid_grant` → `needs_reauth`, sem novas tentativas; falha transitória → status mantido, erro `retryable`.
6. 401 numa chamada → uma renovação forçada (só se ninguém renovou antes) + uma nova tentativa; persistiu → erro `unauthorized`. 429/5xx/timeout → erro tipado `retryable` com `retryAfterSeconds`, sem retry dentro da requisição.

## User Products

Nenhuma estrutura de anúncio foi criada. A conexão guarda `site_id` por integração e o client é genérico (`mercadoLivreRequest`), sem nenhuma suposição de `item_id`/variações — a modelagem de listings (Fase 2) poderá usar identificadores externos extensíveis (`item_id`, `user_product_id`, `family_id`…).

## Testes

- Vitest: 61 testes novos (oauth/http/log 19, tokens/client 16, service 19, rotas 7) cobrindo os 26 itens pedidos — URL OAuth, state válido/expirado/manipulado/replay, callback sem code/com erro, troca code→token, token nunca no navegador/logs, criação/atualização, conflito entre empresas, cifra/decifra, refresh, 2 e 5 refreshes simultâneos (1 chamada ao ML), reaproveitamento do token novo, revogação → needs_reauth, crossover multi-tenant, desconexão/reconexão, `/users/me`, 401/429/5xx/timeout, logs sem segredo, autorização admin.
- SQL (`mercadolivre_oauth.test.sql`): 40 asserções nas RPCs (state, upsert, conflito, lease, fencing, reauth, desconexão, grants/RLS).
- Concorrência real (`mercadolivre_oauth.concurrency.sh`): duas sessões Postgres, só uma obtém o lease.
- Regressão: suítes SQL de integração existentes (`company_integrations_and_external_links`, deliveries) e `product_kits` passando com a migration.

## Passos manuais — DevCenter do Mercado Livre

1. **Criar o app Qarvon** em https://developers.mercadolivre.com.br → Meus aplicativos, com a conta da empresa Qarvon (dona do app, não da Santtorini). Unidade **Mercado Livre** (não Mercado Pago — separação obrigatória desde 30/08/2026; confirme em `GET /applications/$APP_ID` que não há escopos `urn:mp:…`).
2. **Redirect URI**: `https://<DOMÍNIO-DO-QARVON>/api/integrations/mercadolivre/callback` — exatamente igual, https, sem parâmetros.
3. **Escopos**: leitura, escrita e `offline_access` (necessário para refresh_token). Habilitar **PKCE**.
4. **Servidor** (EasyPanel → variáveis de runtime, nunca build args): `MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET`, `MERCADOLIVRE_REDIRECT_URI`, `MERCADOLIVRE_USE_PKCE=true`; `INTEGRATION_SECRETS_*` já existentes.
5. **Aplicar a migration** `202609241000_mercadolivre_oauth_foundation.sql` (primeiro homologação; rodar `mercadolivre_oauth.test.sql` lá).
6. **Agendar** `POST /api/jobs/mercadolivre/refresh-tokens` a cada 30 min (Bearer CRON_SECRET).

## Roteiro de homologação (sem venda)

1. Criar uma **empresa de teste** no Qarvon e um admin nela.
2. Configurações → Mercado Livre → **Conectar** com a conta autorizadora da equipe (administradora, não colaboradora). Verificar: "Conectado", seller id, site MLB.
3. **Revalidar conexão** → última validação atualizada (`/users/me`).
4. Criar usuários TEST (no servidor, consome 1 de 10 cada):
   `node scripts/mercadolivre-test-user.mjs --company-id <empresa-teste> --role seller --confirm`
   `node scripts/mercadolivre-test-user.mjs --company-id <empresa-teste> --role buyer --confirm`
   Guardar as credenciais no cofre (senha não recuperável; código de e-mail = últimos dígitos do user_id).
5. **Desconectar** a conta autorizadora da empresa de teste; em janela anônima, entrar no Mercado Livre com o **TEST seller** e, no Qarvon, **Conectar** → a tela deve mostrar o selo "Usuário TEST".
6. Conferir no banco: `company_integrations` com `external_account_id` = id do TEST seller, `status=active`; `integration_secrets` com 2 linhas cifradas; nenhum token em `settings`.
7. **Renovar token** → `credential_refreshed_at` muda, conexão continua ativa. (Opcional: forçar no banco `credential_expires_at = now()` e usar Revalidar → renova sozinho.)
8. **Desconectar** → status desconectado, segredos apagados, registro preservado.
9. **Reconectar** o TEST seller → mesmo registro reativado.
10. Tentar conectar o mesmo TEST seller a **outra** empresa sem desconectar → deve recusar ("já está conectada a outra empresa").

## Incompatibilidades / observações

- Durante esta fase, outro trabalho em paralelo alterou a Nuvemshop (`src/lib/integrations/nuvemshop.ts`, `src/services/nuvemshop/*`). No último run, **um teste e o build falham por arquivos desse trabalho** (`src/services/nuvemshop/nuvemshop.testutil.ts`: flag de regex exige es2018; `nuvemshop.integration.test.ts` caso 14b). Nada disso é do Mercado Livre: typecheck sem erros fora de `src/services/nuvemshop/`, e todas as suítes de Mercado Livre/kits passam.
- `company_integrations` agora tem as colunas genéricas de OAuth; providers existentes não usam e ficam NULL.

---

## Fechamento da Fase 1 (2026-09-24) — pronto para homologação

- Global: vitest 151 arquivos / 1776 testes ✅ · typecheck 0 erros ✅ · build ✅ · SQL `product_kits` (97) ✅ · SQL `mercadolivre_oauth` ✅ · concorrência kits e ML ✅.
- Os 2 problemas da Nuvemshop (regex `/s` com target ES2017 em `nuvemshop.testutil.ts`; caso 14b) já estavam corrigidos no commit `522e70b` — nenhuma alteração adicional necessária.
- Migration endurecida: os CHECKs de provider/status são removidos pela **definição** (não pelo nome presumido). Validada num banco com integrações pré-existentes de todos os providers/status e CHECK com nome divergente: linhas e segredos preservados, `needs_reauth` aceito, valores inválidos recusados.
- Callback: usuário sem papel admin voltando do ML recebe `reason=forbidden` (antes: `session`).
- Suítes SQL antigas desatualizadas (pré-existentes, fora do escopo): `rpc_create_sale_recipient_atomicity` (cenário 4 contradiz 202609021000), `rpc_create_sale_sale_type` (teste 6 contradiz 20260915), `sales_receipt_token` (cenário 4 colide com o próprio trigger de imutabilidade).

### Comandos após aplicar a migration (banco de HOMOLOGAÇÃO)

```bash
# 1. aplicar (a migration tem BEGIN/COMMIT próprios — não usar -1)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202609241000_mercadolivre_oauth_foundation.sql

# 2. conferir estrutura
psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.company_integrations'::regclass AND contype='c';"
psql "$DATABASE_URL" -c "SELECT proname FROM pg_proc WHERE proname IN ('rpc_consume_oauth_state','rpc_upsert_oauth_integration','rpc_claim_integration_token_refresh','rpc_complete_integration_token_refresh','rpc_fail_integration_token_refresh','rpc_disconnect_oauth_integration') ORDER BY 1;"

# 3. testes (o .sql roda em BEGIN/ROLLBACK; o .sh deixa uma empresa de teste — só em homologação)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/mercadolivre_oauth.test.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/company_integrations_and_external_links.test.sql
DATABASE_URL="$DATABASE_URL" bash supabase/tests/mercadolivre_oauth.concurrency.sh

# 4. após o deploy com as variáveis: job de refresh responde (0 candidatos antes de conectar)
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<DOMINIO>/api/jobs/mercadolivre/refresh-tokens
```
