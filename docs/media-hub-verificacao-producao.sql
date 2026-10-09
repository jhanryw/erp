-- Media Hub — verificações SOMENTE LEITURA para rodar em produção (SQL Editor / psql).
-- Nenhuma query escreve dados. Rode uma a uma e guarde o resultado.

-- 1. Buckets: existência, visibilidade, limites. Esperado: media-public public=true; media-private public=false.
SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id IN ('media-public','media-private');

-- 2. Policies em storage.objects (media-private sem policy = fail-closed; media-public pública por flag do bucket).
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects';

-- 3. RLS ligada nas tabelas do Media Hub? (rowsecurity=false significa só a API protege)
SELECT relname, relrowsecurity AS rls_ligada FROM pg_class
WHERE relnamespace='public'::regnamespace AND relname IN ('media','media_usages','media_renditions');

-- 4. Grants de anon/authenticated nessas tabelas (idealmente vazio; qualquer linha = leitura/escrita via PostgREST).
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name IN ('media','media_usages','media_renditions') AND grantee IN ('anon','authenticated','PUBLIC')
ORDER BY 1,2,3;

-- 5. Mídia sem storage_key e sem external_url, ou pública sem storage_key (causa de imagem que some em silêncio).
SELECT id, public_id, company_id, visibility, storage_key, external_url, active, created_at FROM public.media
WHERE (storage_key IS NULL AND external_url IS NULL) OR (visibility='public' AND storage_key IS NULL AND external_url IS NULL);

-- 6. Registro em media sem objeto no Storage (arquivo sumiu / path errado).
SELECT m.id, m.public_id, m.company_id, m.storage_key
FROM public.media m
LEFT JOIN storage.objects o ON o.bucket_id = CASE m.visibility WHEN 'public' THEN 'media-public' ELSE 'media-private' END AND o.name = m.storage_key
WHERE m.storage_key IS NOT NULL AND o.id IS NULL;

-- 7. Objetos órfãos no Storage (sem registro em media) — uploads cujo INSERT falhou antes da correção.
SELECT o.bucket_id, o.name, o.created_at FROM storage.objects o
LEFT JOIN public.media m ON m.storage_key = o.name
WHERE o.bucket_id IN ('media-public','media-private') AND m.id IS NULL ORDER BY o.created_at DESC;

-- 8. Mídia sem nenhum vínculo (upload feito mas nunca ligado a produto/logo/banner).
SELECT m.id, m.public_id, m.company_id, m.created_at FROM public.media m
WHERE m.active
  AND NOT EXISTS (SELECT 1 FROM public.media_usages u WHERE u.media_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM public.wholesale_site_banners b WHERE b.media_id = m.id);

-- 9. Vínculos de produto apontando para produto de OUTRA empresa ou inexistente (integridade multi-tenant).
SELECT u.id, u.company_id AS usage_company, p.company_id AS product_company, u.entity_id
FROM public.media_usages u LEFT JOIN public.products p ON u.entity_type='product' AND p.id = u.entity_id::int
WHERE u.entity_type='product' AND (p.id IS NULL OR p.company_id <> u.company_id);

-- 10. Vínculos cuja mídia é de outra empresa.
SELECT u.id, u.company_id AS usage_company, m.company_id AS media_company FROM public.media_usages u
JOIN public.media m ON m.id = u.media_id WHERE m.company_id <> u.company_id;

-- 11. Produtos ativos no atacado sem imagem principal.
SELECT p.id, p.name FROM public.products p
WHERE p.active AND p.wholesale_enabled
  AND NOT EXISTS (SELECT 1 FROM public.media_usages u JOIN public.media m ON m.id=u.media_id
                  WHERE u.entity_type='product' AND u.entity_id=p.id::text AND u.role='primary' AND m.active);

-- 12. Logo da empresa existe?
SELECT u.entity_id AS company_id, m.public_id, m.storage_key, m.visibility, m.active FROM public.media_usages u
JOIN public.media m ON m.id=u.media_id WHERE u.entity_type='company' AND u.role='logo';

-- 13. Slugs de categoria duplicados dentro da mesma empresa (entre tipos de produto diferentes).
SELECT company_id, slug, count(*) AS qtd, array_agg(id) AS ids, array_agg(product_type_id) AS tipos
FROM public.categories GROUP BY company_id, slug HAVING count(*) > 1;

-- 14. Categorias legadas com company_id nulo (e quantos produtos usam).
SELECT c.id, c.name, c.slug, c.active, (SELECT count(*) FROM public.products p WHERE p.category_id=c.id) AS produtos
FROM public.categories c WHERE c.company_id IS NULL;
