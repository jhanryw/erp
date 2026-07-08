# Media Hub — Configuração de Storage (Supabase)

Fase 2 do roadmap do ERP. Este documento é a fonte de verdade da configuração
dos buckets do Supabase Storage usados pelo Media Hub — deve bater 1:1 com o
que está criado no painel e com o que `media.service.ts` (ainda não
implementado) vai assumir como verdade.

Buckets são criados manualmente pelo painel do Supabase Storage, não por
migration SQL — é ação em serviço externo, fora do controle de versão do
schema do banco.

## 1–6. Buckets

### `media-public`

| | |
|---|---|
| Nome | `media-public` |
| Finalidade | Imagens públicas de catálogo — produtos, variações, marcas, categorias, coleções e marketplace |
| Visibilidade | Público (`public: true`) — leitura anônima liberada, sem autenticação |
| MIME types permitidos | `image/jpeg`, `image/png`, `image/webp` |
| Tamanho máximo | 5 MB por arquivo |
| Padrão de path | `{company_id}/{public_id}.{extension}` |

### `media-private`

| | |
|---|---|
| Nome | `media-private` |
| Finalidade | Comprovantes, documentos, CRM (anexos de mensagem), financeiro e anexos internos |
| Visibilidade | Privado (`public: false`) — sem leitura anônima |
| MIME types permitidos | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `audio/ogg`, `audio/mpeg`, `audio/aac`, `audio/wav`, `audio/mp4`, `video/mp4`, `video/webm`, `video/quicktime`, `application/pdf`, `application/msword`, `.docx`, `application/vnd.ms-excel`, `.xlsx`, `application/vnd.ms-powerpoint`, `.pptx`, `text/plain` |
| Tamanho máximo | 25 MB por arquivo |
| Padrão de path | `{company_id}/{public_id}.{extension}` |

**Atualizado na Fase 3, Entrega 4** (CRM ↔ Evolution ↔ Media Hub): limite subiu de 15MB→25MB e o allowlist de MIME saiu de "imagem+PDF" para cobertura corporativa geral (áudio/vídeo/documentos comuns) — decisão explícita de tratar `media-private` como serviço compartilhado do ERP, não como algo desenhado só para anexo de WhatsApp. `BUCKET_RULES` em `media.service.ts` é a fonte de verdade em código; esta tabela precisa ser mantida em sincronia manualmente com a configuração real do bucket no painel do Supabase (`file_size_limit`/`allowed_mime_types`, se configurados lá).

Em ambos os buckets, `public_id` é o `UUID` gerado em código (não o `id`
sequencial de `media`) — é o mesmo valor usado como identificador externo
seguro da linha em `media`. Escrita nos dois buckets acontece exclusivamente
via API do ERP (service role); nunca há upload direto do client para o
bucket.

## 7. Regras de segurança

- **`media-public`**: qualquer pessoa que souber o path exato acessa o
  arquivo. A proteção contra descoberta não é o `company_id` no path (que
  aqui é só organização) — é o `public_id` ser um UUID v4 aleatório, não
  adivinhável nem enumerável. Não há isolamento de empresa neste bucket, e
  isso é aceito conscientemente: o conteúdo aqui é, por definição, destinado
  a ficar público na internet (catálogo). O risco real é erro de
  roteamento — um bug que grave conteúdo privado neste bucket por engano
  ficaria exposto permanentemente até ser percebido. Mitigação: a escolha de
  bucket no upload é sempre derivada do campo `media.visibility` (nunca
  decidida manualmente por quem chama a API), e o default de `visibility` já
  é `'private'` — um bug teria que errar ativamente para o lado exposto.

- **`media-private`**: sem leitura anônima. Um bucket privado sem nenhuma
  policy de `storage.objects` criada já é **fail-closed por padrão** no
  Supabase Storage — só `service_role` consegue acessar, mesmo sem RLS de
  Storage definida ainda (diferente de uma tabela Postgres comum, onde RLS
  ausente costuma significar acesso aberto). Isso reduz a urgência de
  RLS de Storage, mas não a elimina como reforço futuro.

- **Isolamento entre empresas**: hoje é garantido inteiramente pela camada
  de API (ver seção 9) — não pelo path nem pelo bucket em si.

## 8. Política de signed URL

Aplicável somente a `media-private`. Signed URLs são geradas sob demanda pela
service layer no momento da leitura autorizada, com TTL de **300 segundos**.
Nunca são armazenadas no banco — o banco guarda apenas `storage_key`; a URL
assinada é recalculada a cada requisição. O bucket `media-public` não usa
signed URL — leitura é via URL pública estável (`getPublicUrl()`), sem
expiração.

## 9. O que fica para RLS futura

- Policy em `storage.objects` para `media-private`, extraindo o primeiro
  segmento do path (`company_id`) via `storage.foldername(name)` e
  comparando com `public.current_company_id()` — mesma função já usada nas
  policies de `products`/`sales`/etc no banco. Reforço de defesa em
  profundidade, não é a única barreira hoje (ver seção 7).
- RLS de tabela em `media`, `media_usages` e `media_renditions` (Postgres,
  não Storage) — identificado no desenho da camada de aplicação, ainda não
  implementado.

Até essas RLS existirem, o isolamento entre empresas depende inteiramente da
service layer (`media.service.ts`, ainda não implementado) sempre filtrar e
validar `company_id` antes de qualquer leitura, escrita ou emissão de signed
URL.

## 10. Como validar no Supabase

Query de leitura, sem efeito colateral, para confirmar que os buckets foram
criados com a configuração esperada:

```sql
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id IN ('media-public', 'media-private');
```

## Próxima etapa

Com os buckets validados, a sequência é: `media.service.ts` →
`/api/media` (rota de upload) → primeiro upload real de teste. O RPC de
"substituir imagem principal" fica para depois do upload básico funcionar.
