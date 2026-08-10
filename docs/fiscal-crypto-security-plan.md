# Dependências Criptográficas e Segurança — Integração Direta SEFAZ

**Tipo:** pesquisa de bibliotecas (Parte 6) + desenho de segurança (Parte 7), **não implementado**. Nenhuma dependência foi instalada. Pesquisa de bibliotecas feita em 2026-08-04 via registro do npm e GitHub ao vivo (não por memória) — metodologia e fontes completas no relatório da pesquisa; este documento consolida o resultado em formato de decisão.

---

## Parte 6 — Bibliotecas candidatas

Princípio observado: **nunca implementar criptografia XML manualmente havendo biblioteca madura e auditável** — confirmado que existem candidatas maduras para XMLDSig e PKCS#12, então nenhuma dessas partes deve ser escrita à mão.

### 1. XML (parsing/construção)

| Candidata | Licença | Última atividade (04/08/2026) | Observação |
|---|---|---|---|
| `fast-xml-parser` | MIT | ~18 dias | Parser + builder no mesmo pacote, TS nativo, sem dependências pesadas |
| `xmlbuilder2` | MIT | ~3 meses | API DOM completa, `engines: >=20.0` — bate exatamente com o Node do projeto |

**Nenhuma implementa regra fiscal.** Uso combinado proposto: `xmlbuilder2` para montar o XML (precisa de manipulação DOM antes da assinatura), `fast-xml-parser` para interpretar respostas SOAP.

### 2. Validação XML contra XSD — lacuna real do ecossistema, tratada com honestidade

**Não existe biblioteca JS pura madura e mantida para validação XSD.** Todas as opções viáveis dependem de libxml2:

| Opção | Natureza | Status |
|---|---|---|
| `libxmljs2-xsd` | Binding nativo (node-gyp) sobre libxml2 | **Estagnada (~3 anos sem atividade)** — não usar como aposta principal |
| `xmllint-wasm` | libxml2 compilado para WASM, roda em worker thread | **Ativamente mantida**, `engines: node>=16`, sem toolchain nativa necessária — **recomendação** |
| Binário `xmllint` via `child_process` | Chamada a processo externo (libxml2-utils instalado no container) | Prática real de mercado (usada por integrações PHP/.NET), viável como alternativa se `xmllint-wasm` apresentar limitação |

**Ressalva honesta:** `xmllint-wasm` não resolve `xsd:import`/`xsd:include` via rede — os XSDs relacionados precisam ser pré-carregados manualmente (baixados do Portal Nacional, nunca de terceiro). **Decisão proposta: `xmllint-wasm`**, com plano B (shell-out para `xmllint`) se surgir limitação real durante o spike (Passo 6 de `fiscal-technical-spike-plan.md`).

### 3. Assinatura digital XML (XMLDSig)

| Candidata | Licença | Última atividade | Observação |
|---|---|---|---|
| `xml-crypto` | MIT | ~5 meses (56 issues abertas) | Suporta `enveloped-signature` + `exc-c14n` (mesmo padrão do SAML); é dependência interna do próprio `soap` — uso real comprovado em produção por terceiros |
| `xmldsigjs` | MIT | hoje | Implementação TS sobre Web Crypto API (precisa shim `@peculiar/webcrypto` em Node), parte de um conjunto maior mantido ativamente (PKI.js, xadesjs) |

Ambas genéricas, sem regra fiscal embutida — a regra de "qual tag assinar, com qual `Reference URI`" é definida pelo MOC 7.0 Anexo I e fica sob responsabilidade da aplicação (`xmlSigner.ts` proposto). **Decisão proposta: `xml-crypto`**, por ter uso comprovado em produção via `soap` e maior volume de adoção — reavaliar `xmldsigjs` se `xml-crypto` apresentar limitação durante o spike (Passo 7).

### 4. Leitura de certificado PKCS#12/PFX

| Candidata | Licença | Última versão | Observação crítica |
|---|---|---|---|
| `node-forge` | BSD-3/GPL-2.0 | 1.4.0 | **CVE-2025-12816** (bypass de verificação de assinatura) e **CVE-2025-66031** (DoS por recursão ASN.1) corrigidos só na 1.4.0 — **fixar >=1.4.0 é obrigatório, não opcional** |
| `pem` | MIT | ~5 dias | Faz shell-out para OpenSSL — exige OpenSSL instalado no ambiente de execução (container Docker precisa incluir) |
| `p12-pem` | ISC | inativa (~12+ meses sem atividade) | Não recomendada |

O módulo `crypto` nativo do Node **não tem API pública para decodificar PKCS#12 diretamente** — uma das opções acima é necessária. **Decisão proposta: `node-forge >=1.4.0`**, travado por `package.json` com `^1.4.0` (nunca um range que permita voltar a versões vulneráveis) — monitorar advisories continuamente, dado que é o componente que manipula a chave privada.

### 5. Cliente SOAP

| Candidata | Licença | `engines.node` | Observação |
|---|---|---|---|
| `soap` (node-soap) | MIT | `>=20.19.0` | Cliente WSDL completo, já depende de `xml-crypto` internamente; **confirmar que a produção roda Node >=20.19.0**, não só "20.x" genérico |
| `strong-soap` | MIT | `>=22` | **Incompatível com Node 20 do projeto hoje** — descartada, a menos que haja upgrade de runtime planejado |
| `easy-soap-request` | MIT | amplo | Wrapper fino sobre `axios` — não interpreta WSDL, envelope SOAP montado manualmente |

**Nota de mercado (da pesquisa):** integrações reais com SEFAZ (PHP nfephp/sped-nfe, .NET) costumam montar o envelope SOAP manualmente em vez de depender de introspecção de WSDL, porque os WSDLs estaduais às vezes são inconsistentes. **Decisão proposta: `easy-soap-request`** para o envelope + `fast-xml-parser` para interpretar a resposta — mais previsível e mais fácil de depurar do que confiar na introspecção automática de WSDL do `soap`. Reavaliar durante o spike (Passo 4) se a montagem manual do envelope se mostrar mais trabalhosa do que o esperado.

### 6. mTLS

**Nativo — confirmado, nenhuma biblioteca terceira necessária.** `https.Agent`/`tls.connect` do Node 20 aceitam `cert`/`key`/`ca`/`passphrase` (PEM) ou `pfx`+`passphrase` diretamente. Pegadinhas documentadas: cadeia intermediária deve ser concatenada ao certificado-folha; formato PEM (não DER) para `cert`/`key`; nunca desabilitar `rejectUnauthorized` fora de teste local.

### 7. Geração de QR Code

| Candidata | Licença | Última atividade | Observação |
|---|---|---|---|
| `qrcode` | MIT | ~2 anos sem push (sinal de estabilidade, não abandono) | API alto nível, `toDataURL`/`toBuffer`/`toFile`/SVG |
| `qrcode-generator` | MIT | ~6 meses | API baixo nível (só matriz de módulos), sem renderizador embutido |

**Decisão proposta: `qrcode`** — API mais direta para o caso de uso (gerar imagem/SVG do QR Code para o DANFE). A montagem da URL do QR Code em si (chave de acesso + hash do CSC) é regra fiscal da aplicação, não da lib.

### 8. Geração/renderização de DANFE

| Candidata | Licença | `engines.node` | Observação |
|---|---|---|---|
| `pdfkit` | MIT | `>=20.0.0` | API vetorial de baixo nível, bom fit para layout fixo (DANFE tem posições especificadas pelo manual oficial), deploy leve |
| `playwright` (HTML→PDF) | Apache-2.0 | `>=20` | Permite template HTML/CSS, mais fácil de iterar visualmente; trade-off: peso do Chromium na imagem de deploy |
| `puppeteer` | Apache-2.0 | `>=22.12.0` | **Incompatível com Node 20 hoje** — descartada sem upgrade de runtime |
| `@nfewizard/danfe` | **GPL-3.0** | ativa | Única lib brasileira de DANFE genuinamente ativa encontrada — **mas é copyleft forte e embute regra fiscal completa**, exatamente o padrão de dependência a evitar. Requer parecer jurídico antes de sequer cogitar, e não resolve o objetivo de manter a regra fiscal sob controle próprio |

**Decisão proposta: `pdfkit`** para o cupom NFC-e 80mm (layout rígido, requisito de deploy leve no ambiente PDV) — reavaliar `playwright` especificamente para o DANFE A4 de NF-e (Entrega I, menos urgente) se a iteração visual em `pdfkit` se mostrar lenta. **`@nfewizard/danfe` não deve ser adotada** sem avaliação jurídica formal da licença GPL-3.0, e mesmo assim contraria o princípio de não depender de terceiros para regra fiscal.

---

## Parte 7 — Desenho de Segurança

### Certificado apenas no backend
O certificado (PFX) e a senha nunca trafegam para o navegador, nunca são referenciados em nenhum componente `'use client'`, e nunca aparecem em nenhuma variável `NEXT_PUBLIC_*` (já confirmado nesta auditoria que `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` não existe hoje — o mesmo princípio se aplica ao certificado fiscal). Só `SvrsFiscalGateway` (rodando em rota de API/service, nunca em Server Component renderizado com dados sensíveis) tem acesso ao material decodificado, e só em memória, nunca persistido em disco do container.

### Secret de runtime, nunca build ARG
**Correção obrigatória antes de introduzir o certificado:** o Dockerfile atual declara `SUPABASE_SERVICE_ROLE_KEY`/`CRON_SECRET` como `ARG` de build (achado A7 do registro de riscos, `Dockerfile:5-9,16-21,29-40`) — isso não deve se repetir para `CERTIFICATE_PFX_BASE64`/`CERTIFICATE_PASSWORD`/`NFCE_CSC_ID`/`NFCE_CSC_TOKEN`. Esses quatro segredos devem ser injetados **exclusivamente como variável de ambiente de runtime** (Secret do EasyPanel, conforme já recomendado em `fiscal-architecture-proposal.md` §7), nunca como `ARG`/`ENV` fixado na imagem.

### Senha separada
`CERTIFICATE_PFX_BASE64` e `CERTIFICATE_PASSWORD` são dois segredos distintos, nunca concatenados num único valor nem armazenados na mesma linha de configuração — isso limita o dano se um dos dois vazar isoladamente (ex.: log acidental do base64 sem a senha ainda não permite abrir o PFX).

### Redaction de logs
Nenhuma rotina de log (incluindo o `console.error`/`auditLog()` já existentes no projeto) pode receber o PFX, a senha, a chave privada extraída, ou o XML **antes** de sanitização. Proposta: um utilitário central `redactFiscalSecrets(payload)` usado em todo ponto de log do módulo fiscal, que remove/mascara qualquer campo correspondente a segredo conhecido antes de logar — nunca confiar em cada chamador individual para lembrar de sanitizar manualmente.

### Rotação
`fiscal_credentials.valid_until` (já proposto em `fiscal-architecture-proposal.md` §2) permite ter mais de um certificado ativo por período de transição — o processo de rotação é: cadastrar o novo certificado com `active=false`, testar em homologação, promover para `active=true` e desativar o antigo, nunca sobrescrever o segredo em uso sem um certificado testado pronto para substituí-lo.

### Alertas de validade
Já desenhado em `fiscal-architecture-proposal.md` §7 (limiares de 60/30/15/10/7/5/2 dias) — reaproveitando `src/lib/push/send.ts`. Sem mudança nesta etapa, só reafirmado como pré-requisito de produção (Entrega H).

### Separação de homologação e produção
`fiscal_document_series`/`fiscal_credentials`/`fiscal_documents` já modelados com `environment` como coluna explícita (`fiscal-architecture-proposal.md` §2). A implementação do `SvrsFiscalGateway` deve resolver o endpoint (homologação vs. produção) a partir dessa coluna, **nunca de uma variável de ambiente global única** — isso permite, no futuro, que homologação e produção coexistam no mesmo deploy sem risco de mistura acidental (ainda que a recomendação de infraestrutura continue sendo deploys físicos separados, ver `fiscal-architecture-proposal.md` §11).

### Bloqueio explícito de produção
`fiscal_establishments.ambiente_producao_habilitado` (já proposto, default `false`) — nenhuma chamada de `authorize()` para ambiente `producao` deve ser aceita pelo `SvrsFiscalGateway` se essa flag não estiver `true` para a empresa/estabelecimento em questão. Esta é uma trava em código, redundante com a separação de ambiente acima — **defesa em profundidade deliberada**, já que o custo de uma transmissão real acidental é alto (obrigação fiscal gerada).

### Trilha de auditoria
Reaproveitar `audit_logs` (já confirmado como reutilizável, `fiscal-architecture-proposal.md` §2) com `resource: 'fiscal_document'` para toda chamada ao `FiscalGateway` (não só o resultado final) — incluindo tentativas rejeitadas, para permitir reconstruir a história completa de cada documento.

### Storage privado dos XMLs
Já desenhado (`fiscal-architecture-proposal.md` §8), reaproveitando o padrão do Media Hub — bucket privado, chave nunca sequencial, signed URL de curta duração.

### Hash de integridade
`fiscal_files.checksum_sha256` (já proposto) — calculado no momento do armazenamento, permite detectar corrupção/alteração posterior do XML autorizado, que deve ser tratado como imutável.

---

## Pré-requisito transversal: correção do RLS crítico

**Reafirmado explicitamente aqui, por instrução direta do usuário:** a correção das policies RLS abertas (`rls-open-policies-remediation-plan.md`, já pronto para autorização) é tratada como **pré-requisito para ativar o módulo fiscal em produção**, não uma tarefa paralela opcional. Motivo: `fiscal_documents`/`fiscal_credentials`/`fiscal_files` são exatamente o tipo de dado (obrigação legal, segredo de certificado referenciado, XML autorizado) que não pode herdar o mesmo padrão de policy `USING(true)` já encontrado em `sales`/`customers`/`products`/`users`. Se as novas tabelas fiscais forem criadas (Entrega B) sem que o padrão de RLS do projeto já esteja corrigido, existe risco real de repetir o mesmo erro por hábito/copy-paste de uma migration existente como modelo. **Ordem recomendada: Entrega A (RLS) conclui antes de qualquer tabela fiscal ganhar dado real de produção — pode ser desenvolvida em paralelo com Entregas B/C, mas não pode ficar pendente quando a Entrega H (produção) for autorizada.**

**Nenhuma dependência foi instalada, nenhum segredo foi criado, nenhuma correção de RLS foi executada nesta etapa.**
