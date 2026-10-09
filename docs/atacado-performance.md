# Atacado — auditoria de performance (09/10/2026)

## Medições ANTES (produção, https://atacado.santtorini.com/, Lighthouse 12, Chrome headless)
| | Mobile | Desktop |
|---|---|---|
| Pontuação | **53** | 92 |
| FCP | 1,4 s | 0,3 s |
| **LCP** | **16,1 s** | 1,8 s |
| TBT | 860 ms | 0 ms |
| CLS | 0 | 0 |
| Peso total / requisições | 11,8 MB / 51 | 13,9 MB / 57 |
| Resposta do HTML (servidor) | 300 ms | 360 ms |

`curl` (3 execuções): TTFB 1,79 s (frio), 0,92 s, 0,66 s; com gzip o HTML tem 13,7 KB.
Elemento do LCP: a primeira imagem dos cards de categoria (`<img>` de 442 KB, original do Storage).

## Gargalos (evidência)
1. **Imagens sem otimização — causa dominante.** 25 JPEGs originais (319–766 KB, média ~550 KB, total 13,7 MB) exibidos em ~180–280 px. O `/_next/image` de produção devolvia o arquivo original (734.217 bytes = tamanho do original para w=384 e w=640): sem `sharp` no modo standalone o Next 14 registra "'sharp' is required to be installed in standalone mode" e cai para o arquivo de origem. Reproduzido localmente com a mensagem exata.
2. Cards de produto e categoria usavam `<img>` direto no original (sem srcset/sizes).
3. `minimumCacheTTL` padrão (60 s): o resultado otimizado seria revalidado a cada minuto.
4. Backend: cada requisição repetia a carga completa (produtos + variações + estoque) em `page` e `listWholesaleCategories`, e as configurações eram lidas 4+ vezes. Custo medido no servidor: 300–360 ms de resposta — relevante, mas não é o gargalo do LCP.

## Alterações
- `sharp` como dependência (otimizador funcional em produção), `minimumCacheTTL` de 30 dias (arquivos têm nome UUID imutável), tamanhos de imagem enxutos.
- `CatalogImage`: cards de produto/categoria, "Adicione também", carrinho e página de produto passam pelo otimizador com `sizes` corretos; URLs externas continuam `<img>`.
- Banner/primeiras categorias com prioridade só quando são o LCP.
- Cache em memória por empresa (30 s, single-flight, invalidação pelo ERP) para configurações, logo, banners, categorias, lista de produtos visíveis e páginas sem busca; busca e categoria filtram a lista em memória.
- Instrumentação: `WHOLESALE_PERF_LOG=1` registra uma linha JSON por etapa (produtos, variações, estoque, categorias, página).

## Medição DEPOIS
- Otimizador local (build standalone com `sharp`) sobre as 25 imagens reais de produção, w=414, WebP: **13.686 KB → 202 KB (−99%)**, ~0,3 s na 1ª requisição, depois cache.
- Lighthouse/TTFB "depois": **só é possível após o deploy** — rode os comandos abaixo.

## Como medir depois do deploy
```bash
npx lighthouse@12 https://atacado.santtorini.com/ --only-categories=performance --output=json --output-path=./lh-mobile.json
npx lighthouse@12 https://atacado.santtorini.com/ --preset=desktop --only-categories=performance --output=json --output-path=./lh-desktop.json
for i in 1 2 3; do curl -s -o /dev/null -w "ttfb=%{time_starttransfer} total=%{time_total}\n" https://atacado.santtorini.com/; done
```

## Consultas somente leitura para o banco (plano de execução)
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name, category_id FROM products
 WHERE company_id = <ID> AND active AND wholesale_enabled ORDER BY name, id;
EXPLAIN (ANALYZE, BUFFERS) SELECT id, product_id FROM product_variations WHERE product_id = ANY(<ids>) AND active;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM stock_balances WHERE product_variation_id = ANY(<ids>);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM media_usages WHERE entity_type='product' AND entity_id = ANY(<ids>) AND company_id = <ID>;
SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('products','product_variations','stock_balances','media_usages');
```

## Riscos
- Cache de 30 s: preço/estoque/disponibilidade na VITRINE podem ficar até 30 s defasados. Validação do carrinho e criação do pedido leem direto do banco (e as configurações com `fresh: true`).
- Cache é por processo: com várias réplicas, a invalidação do ERP só alcança a réplica que recebeu a mutação (TTL cobre as demais).
- `WHOLESALE_CACHE_TTL_MS=0` desliga o cache sem deploy de código.
