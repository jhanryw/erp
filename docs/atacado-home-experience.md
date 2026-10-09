# Atacado — nova home (banner, categorias com foto, "Adicione também")

Branch `feat/atacado-home-experience` (parte de `fix/media-hub-image-hosts`, commit `bf3f07f`).

## O que mudou
- **Banners** (`wholesale_site_banners`): imagem desktop + mobile, título/subtítulo/botão opcionais, "só imagem" (`show_text=false`), destino, ordem e ativação. Gestão: ERP → Configurações → Atacado.
- **Categorias com foto** (`wholesale_category_covers`): capa por categoria no ERP; sem capa usa a foto de um produto da categoria; sem foto, card tipográfico. Chave pública `?categoria=` única (`slug`, ou `slug~id` quando o slug se repete na empresa).
- **Adicione também**: `GET /api/wholesale/recomendacoes`; 4–6 produtos elegíveis fora do carrinho, estáveis na sessão (hash da seed).
- **Home**: cabeçalho (logo, busca, carrinho) → banner → categorias → catálogo → rodapé. Banner e cards só na home sem busca/filtro/página.

## Migrations (aplicar nesta ordem, aditivas e reaplicáveis)
1. `202610091000_wholesale_banners_text_mobile.sql`
2. `202610091100_wholesale_category_covers.sql`

## Deploy
1. Backup/snapshot do banco. 2. Aplicar as duas migrations. 3. Garantir o build-arg `NEXT_PUBLIC_SUPABASE_URL` no build da imagem (ver docs/media-hub-verificacao-producao.sql). 4. Build/deploy da imagem. 5. Checklist abaixo.

## Rollback
Reimplantar a imagem anterior. O código antigo ignora as colunas/tabela novas (aditivas) — as migrations não precisam ser revertidas. Reversão de schema, se desejada: bloco ROLLBACK ao final de cada migration.

## Checklist pós-deploy
- [ ] Logo no cabeçalho (desktop e celular); `/_next/image` responde 200.
- [ ] ERP → Atacado: criar banner com imagem desktop e mobile; textos; "só imagem"; reordenar; desativar.
- [ ] Home no celular: banner quadrado, sem rolagem horizontal; no desktop 3:1.
- [ ] ERP → Atacado → Fotos das categorias: enviar capa; card atualiza na home.
- [ ] Clique no card filtra os produtos e rola até a lista; busca do cabeçalho funciona.
- [ ] Categorias de mesmo slug (query 13 do docs/media-hub-verificacao-producao.sql) aparecem separadas.
- [ ] Carrinho: "Adicione também" mostra 4–6 itens fora do carrinho; adicionar atualiza o total; pedido mínimo respeitado; envio abre o WhatsApp.
- [ ] Catálogo desativado continua mostrando só logo/mensagem.

## Personalização do site (textos)
Configurações → Atacado → "Personalização do site": título/subtítulo da vitrine, título de categorias, título de produtos, título de "Adicione também", texto informativo do pedido mínimo, mensagem de lista vazia e rodapé. Campo vazio = texto padrão. Persistido em `wholesale_site_settings` (por `company_id`), lido a cada requisição — vale no site assim que salvar, sem deploy. Texto puro (HTML não é interpretado). O valor do pedido mínimo continua em "Pedido mínimo (R$)".

Migration adicional (aplicar depois das duas anteriores): `202610091200_wholesale_site_texts.sql`.

Checklist extra:
- [ ] Editar cada texto no ERP, salvar e ver no site público sem deploy (recarregar a página).
- [ ] Limpar um campo e confirmar que volta ao texto padrão.
- [ ] Texto com `<b>` ou `<script>` aparece literalmente, sem formatar nem executar.
- [ ] O mínimo do pedido continua bloqueando o envio conforme o valor configurado, independente do texto.
