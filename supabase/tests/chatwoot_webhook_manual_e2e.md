# Teste manual end-to-end — Webhook Chatwoot (Fase 3)

Cobre, num único roteiro, o teste manual pedido na seção 39/N e os cenários
de tenant/contato/idempotência/ordem pedidos nas seções 41-44 do pedido da
Fase 3 — nenhum deles é automatizável em `vitest` (dependem de banco real e
de uma requisição HTTP de verdade) nem em SQL puro (a lógica de resolução
de contato é orquestrada em TypeScript, não é uma RPC única). Rode contra
um banco/app de **teste**, nunca produção.

Pré-requisito: `npm run dev` rodando, migrations da Fase 2 aplicadas,
`.env.local` com `INTEGRATION_SECRETS_CURRENT_KEY_VERSION` e
`INTEGRATION_SECRETS_MASTER_KEY_V<n>` configuradas.

## 0. Gerar fixture + curl assinado

```bash
node scripts/chatwoot-webhook-test-setup.mjs \
  --company-id 1 \
  --account-id 123 \
  --webhook-secret "segredo-de-teste-qualquer-coisa" \
  --base-url http://localhost:3000
```

Rode o SQL impresso contra o banco de teste, depois use o `curl` impresso
como base pros cenários abaixo (ajustando o JSON do `-d` e recalculando a
assinatura quando o payload mudar — o script sempre imprime uma assinatura
válida pro payload de exemplo dele; pra outros payloads, rode o script de
novo trocando o conteúdo de `samplePayload` nele, ou calcule manualmente:
`sha256=` + HMAC-SHA256(secret, `${timestamp}.${body}`)).

---

## 1. Assinatura (seção 40 do pedido — já 100% coberto por `signature.test.ts`, 11 testes automatizados)

Sem re-testar aqui manualmente — só confirme que o `curl` do passo 0
retorna **200**. Se retornar 401, os testes automatizados de
`signature.test.ts` já isolam se é o algoritmo (não deveria — está
testado) ou a fixture (secret errado no SQL vs no curl, timestamp
desatualizado se você demorou entre gerar e rodar).

---

## 2. Tenant (seção 41)

**2.1 — Duas empresas, duas integrações:**
```bash
# Empresa A (já criada no passo 0, account_id=123)
# Empresa B — gere uma segunda fixture:
node scripts/chatwoot-webhook-test-setup.mjs --company-id 2 --account-id 456 --webhook-secret "outro-secret" --base-url http://localhost:3000
```
Rode os dois `curl`s gerados. Confirme no banco:
```sql
SELECT cp.company_id, cp.display_name FROM public.crm_persons cp
JOIN public.external_entity_links l ON l.entity_id = cp.id::text AND l.entity_type = 'crm_person'
WHERE l.external_id IN ('999001');
```
**Esperado:** a `crm_person` criada pelo webhook da conta 123 tem
`company_id=1`; a da conta 456 tem `company_id=2` — nunca cruzam.

**2.2 — Payload de B assinado com secret de A → rejeitado:**
```bash
# Pegue o payload/timestamp do curl da empresa B, mas assine com o
# webhook-secret DA EMPRESA A (recalcule a assinatura manualmente ou gere
# a fixture de B e troque só o header X-Chatwoot-Signature pelo valor que
# o script imprimiu pra A).
```
**Esperado:** **401**, nenhum dado é criado. Isso prova que o secret
errado é detectado mesmo quando o `account_id` do payload aponta
corretamente pra uma integração real — a seleção de integração candidata
(passo 1 da rota) nunca é suficiente sozinha, a assinatura é quem decide.

---

## 3. Contato (seção 42)

Gere payloads variando o `contact_created` de exemplo do script (edite
`samplePayload` no script ou monte o JSON à mão + recalcule a assinatura):

| Cenário | payload | Verificar |
|---|---|---|
| Novo contato só telefone | `phone_number` presente, `email: null` | `crm_channel_identities` ganha 1 linha `whatsapp`; `crm_persons` ganha 1 linha |
| Novo contato só email | `email` presente, `phone_number: null` | idem, canal `email` |
| Novo contato com os dois | ambos presentes | **1 só** `crm_persons`, com **2** `crm_channel_identities` (whatsapp + email) |
| Contato já linkado (repita o mesmo `id`) | segundo `contact_updated` pro mesmo `id` | **nenhuma** `crm_person` nova — `external_entity_links` já existente é reaproveitado |
| `contact_updated` com telefone alterado | mesmo `id`, `phone_number` diferente do original | mesma `crm_person`, identidade antiga continua ativa + nova identidade anexada (não recria pessoa — seção 20) |
| Telefone inválido (`phone_number: "123"`) | | `normalizeE164BR` retorna vazio → nenhuma identidade de telefone criada; se `email` também ausente, `status: 'no_identity'` (sem `crm_person` criada) |
| Sem `customer` correspondente | contato novo, nenhum `customers.phone_e164`/`email` bate | `crm_person` criada, **sem** `crm_person_customer_links` — válido (lead sem compra, seção 22) |
| `customer` match HIGH_CONFIDENCE | telefone do contato bate com `customers.phone_e164` de EXATAMENTE 1 cliente real | `crm_person_customer_links` criado, `match_source='phone_match'` |
| `customer` match AMBIGUOUS | telefone bate com 2+ customers (exige fixture com duplicidade real) | **nenhum** `crm_person_customer_links` criado |
| `customer` match CONFLICT | telefone → customer X, email → customer Y diferentes | idem, nenhum link automático |

Query de verificação genérica:
```sql
SELECT cp.id AS person_id, cp.display_name,
  (SELECT array_agg(channel_type || ':' || value) FROM public.crm_channel_identities WHERE person_id = cp.id AND active) AS identidades,
  (SELECT customer_id FROM public.crm_person_customer_links WHERE person_id = cp.id AND active LIMIT 1) AS customer_linkado
FROM public.crm_persons cp
JOIN public.external_entity_links l ON l.entity_id = cp.id::text AND l.entity_type = 'crm_person'
WHERE l.external_id = '<contact_id_do_teste>';
```

---

## 4. Idempotência (seção 43)

Envie o **mesmo** payload de `contact_created` (mesmo `id`, mesmo
`X-Chatwoot-Timestamp`/assinatura ou um novo par timestamp+assinatura
válido, tanto faz) **1x, depois 2x, depois 5x seguidas**:
```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST 'http://localhost:3000/api/integrations/chatwoot/webhook' \
    -H 'Content-Type: application/json' \
    -H "X-Chatwoot-Timestamp: $(date +%s)" \
    -H "X-Chatwoot-Signature: <recalcular pra cada timestamp novo>" \
    -d '<mesmo payload>'
done
```
**Esperado:** todas as respostas 200; ao final,
```sql
SELECT COUNT(*) FROM public.crm_persons cp
JOIN public.external_entity_links l ON l.entity_id = cp.id::text
WHERE l.external_id = '<contact_id>';
```
retorna exatamente **1**, e `crm_channel_identities`/`crm_person_customer_links`
também sem duplicata (garantido pelos índices únicos já existentes, não
por uma tabela de log de entregas nova — decisão da seção 27/28 do pedido).

---

## 5. Ordem de webhook não garantida (seção 44)

**5.1 — `conversation_created` chega ANTES de `contact_created`:**
Monte um payload `conversation_created` com `meta.sender` (ou
`contact_inbox.contact`) contendo o MESMO `id`/telefone de um contato que
você ainda não enviou via `contact_created`. Envie-o primeiro.
**Esperado:** `crm_person` já é criada a partir do evento de conversa
(200, `outcome: 'created'`).

Depois envie o `contact_created` correspondente (mesmo `id` de contato).
**Esperado:** reconhece o `external_entity_links` já existente (criado
pelo evento de conversa), reaproveita a mesma `crm_person` — não duplica.

**5.2 — Inverso**: `contact_created` primeiro, `conversation_created` depois
— comportamento já coberto pelo fluxo normal (contato resolvido, depois a
conversa só reconfirma o mesmo vínculo).

**Confirmar estado final convergente:**
```sql
SELECT COUNT(DISTINCT cp.id) FROM public.crm_persons cp
JOIN public.external_entity_links l ON l.entity_id = cp.id::text
WHERE l.external_id = '<contact_id>';
```
Esperado: **1**, independente da ordem de envio.

---

## Conclusão a registrar após rodar

- [ ] Assinatura válida → 200; secret errado (mesmo account_id certo) → 401.
- [ ] Tenant: 2 empresas nunca cruzam dado; payload de B assinado com secret de A → 401.
- [ ] Contato: todos os 10 cenários da tabela da seção 3 conferidos.
- [ ] Idempotência: 5 envios do mesmo evento → 1 `crm_person`, sem duplicata em nenhuma tabela.
- [ ] Ordem: `conversation_created` antes de `contact_created` converge pro mesmo estado que a ordem inversa.
