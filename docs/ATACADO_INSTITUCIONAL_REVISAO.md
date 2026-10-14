# Atacado institucional — revisão pré-integração (14/10/2026)

## 1. WhatsApp flutuante no produto (mobile)
- `/carrinho`: oculto no celular (inalterado). `/produto`: sempre presente; recua (`opacity-0`, sem clique, fora do foco)
  enquanto o botão (+8px) sobrepõe qualquer `button/input/select/textarea/a/[role=button]` de `main`, e volta ao sair de cima.
- Reavalia em scroll, resize, click e input (rAF). Cobertura: `FloatingWhatsApp.test.tsx`.
- Não validado em navegador real com produto de verdade (sem dev server nesta rodada) — conferir após deploy.

## 2. Origem dos dados fiscais do rodapé
- Tenant do site = `resolveWholesaleSiteTenant()` (usuário de sistema por env; nunca company_id do browser).
- `getFiscalProfile(companyId)` lê `company_fiscal_settings` com `.eq('company_id', companyId)`; a tabela tem
  `company_id UNIQUE` (1 registro/empresa), então não há ambiguidade de estabelecimento. Cache keyed por empresa.
- Só é usado com `store.useFiscalData` ligado; valor digitado no ERP tem prioridade; erro → vazio.
- Teste: `fiscalProfile.test.ts` (filtro por company_id, sem mistura de cache, falha → vazio).
- Ressalva: o cadastro fiscal traz o estabelecimento emissor único da empresa; se houver filiais no futuro, o modelo precisará de escolha explícita.

## 3. 502 em atacado.santtorini.com (somente leitura)
- Em 14/10/2026 ~15:15 UTC: DNS A → 82.25.68.222; HTTPS 200 em `/` e `/carrinho` (3/3 tentativas, ~0,3–0,55 s);
  `/produtos` 404 (rota inexistente, esperado); `/api/health` 307 → /login (middleware).
- Conclusão: DNS, Traefik, container, porta e aplicação respondem; não reproduzi o 502. Sem acesso à infra, não é possível
  afirmar a causa do 502 anterior (candidatos: restart/deploy em andamento, healthcheck, OOM). Ver logs do EasyPanel.
- O que está no ar NÃO contém esta branch (não há anúncios/rodapé novo).

## 4. Histórico
- `origin/main` = d52851e; a branch parte exatamente dele (0 commits atrás, 4+ à frente). Sem conflitos de integração.
