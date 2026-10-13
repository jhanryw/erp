# Atacado — IP confiável, IP desconhecido e fallback de WhatsApp

## O que o app faz (verificado por testes)
| Situação | IP usado no rate limiting | Limite por hora |
|---|---|---|
| `WHOLESALE_CLIENT_IP_HEADER` configurado e com IP válido | esse cabeçalho | 30 por IP |
| `WHOLESALE_TRUSTED_PROXY_HOPS=N` e cadeia XFF com ≥ N entradas | N-ésima entrada **da direita** do `X-Forwarded-For` | 30 por IP |
| Nada configurado, cabeçalho ausente/inválido, cadeia curta | **desconhecido** → balde compartilhado | 60 no balde (`WHOLESALE_ORDERS_UNKNOWN_IP_PER_HOUR`) |
| Sempre | — | teto de 200 por empresa; idempotência por chave UUID |

O app **nunca** usa `X-Forwarded-For`/`X-Real-IP` como veio do cliente quando nada foi declarado como confiável. Entradas à
esquerda do XFF (forjáveis) são ignoradas no modo `HOPS`. Antes, IP ausente desligava o limite por IP; agora cai no balde.

## Por que 60 no balde desconhecido
Abaixo do teto da empresa (200) para que o balde sozinho não esgote a loja, mas acima do por-IP (30) porque, sem proxy
confiável configurado, vários clientes legítimos compartilham o balde. Ajuste por env conforme o volume real.

## Configuração necessária (EXTERNA — não verificada em produção)
1. O app só pode ser alcançado **através do Traefik** (container sem porta publicada na internet). Se for alcançável direto,
   qualquer cabeçalho pode ser forjado e nenhuma das opções abaixo é segura.
2. Escolha UMA opção:
   - **A)** `WHOLESALE_CLIENT_IP_HEADER=x-real-ip` — vale se o Traefik **sobrescreve** `X-Real-Ip` com o IP do par (padrão com
     `forwardedHeaders.insecure=false`; confirmar na configuração do Traefik/EasyPanel).
   - **B)** `WHOLESALE_TRUSTED_PROXY_HOPS=1` — Traefik acrescenta o IP do par ao final do `X-Forwarded-For`; o app usa a última
     entrada. Se houver CDN antes do Traefik, use `2` (e confirme que o CDN não é contornável).
3. Se houver Cloudflare: `WHOLESALE_CLIENT_IP_HEADER=cf-connecting-ip` e bloquear acesso direto ao Traefik que não venha do CDN.

## Como validar depois do deploy (leitura)
Faça dois pedidos de teste do mesmo aparelho, um deles com `X-Real-IP: 9.9.9.9` e `X-Forwarded-For: 8.8.8.8` forjados, e compare:
```sql
SELECT code, request_ip_hash, created_at FROM wholesale_orders ORDER BY created_at DESC LIMIT 5;
```
Os dois `request_ip_hash` devem ser **iguais** (cabeçalhos forjados não mudam o IP) e **diferentes** do hash de um pedido feito de
outra rede. Se forem diferentes entre si, a borda não está sobrescrevendo/limpando o cabeçalho. Os logs `wholesale_order_rate_limited`
trazem `ip_known: true|false`.

## Fallback de WhatsApp (só rate limiting)
- Acontece apenas quando o registro responde `429 rate_limited`; o carrinho **já foi validado** (estoque, preço, mínimo) pelo servidor.
- A mensagem é montada **no servidor** com as linhas do banco; o navegador não influencia texto, preço nem quantidade.
- Sem código de pedido, sem tela de sucesso, sem evento de conversão. Diz que o pedido ainda não foi registrado e será confirmado pela loja.
- Não é usado para estoque/preço/mínimo/validação/autorização/erro interno (testado). A resposta pública não traz `validation` nem linhas internas.
- Abuso: o link só contém dados do catálogo público e abre a conversa a partir do WhatsApp do próprio cliente; não amplia a capacidade
  de enviar spam (qualquer pessoa já pode abrir um `wa.me` para a loja). O custo extra é a validação do carrinho, já exposta em `/api/wholesale/cart/validate`.
