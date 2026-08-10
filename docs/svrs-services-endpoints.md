# Serviços e Endpoints SVRS — NF-e e NFC-e (Rio Grande do Norte)

**Tipo:** registro de pesquisa técnica em fontes oficiais, para fundamentar a integração direta com a SEFAZ. Nenhuma transmissão foi feita. Nenhum endpoint foi chamado — apenas consultado em documentação pública.

**Metodologia e aviso de confiança:** pesquisa feita em 2026-08-04 diretamente nos domínios oficiais (`nfe.fazenda.gov.br` — Portal Nacional da NF-e; `dfe-portal.svrs.rs.gov.br`/`nfe.svrs.rs.gov.br`/`nfce.svrs.rs.gov.br` — SVRS; `gov.br/receitafederal`; `sefaz.rn.gov.br`/`uvt.sefaz.rn.gov.br` — SEFAZ/RN). Nenhum blog, tutorial ou fórum foi usado como fonte de especificação — só domínios oficiais. **Ressalva importante:** várias datas de "última atualização" foram capturadas como "hoje" (04/08/2026) pela ferramenta de pesquisa — isso pode refletir a data de acesso à página dinâmica, não necessariamente a data real de publicação do conteúdo. Onde isso é relevante para uma decisão de compliance formal (ex.: data exata de uma Nota Técnica), recomenda-se reconfirmação manual direta antes de usar a data em documentação jurídica/contábil. Os fatos substantivos (existência do documento, URLs, números de versão) foram extraídos do conteúdo vivo da página oficial, não de cache ou terceiros, e são tratados como confiáveis.

---

## 1. Confirmação: RN usa SVRS como autorizador

**Confirmado em fonte oficial primária.** Avisos publicados pela própria Secretaria de Estado de Tributação do RN no Portal Nacional da NF-e (histórico de 2023 a 2026, o mais recente datado 15/07/2026) confirmam repetidamente: *"ambiente de autorização dos Documentos Fiscais eletrônicos (NF-e e NFC-e) da SVRS e SEFAZ-RS"*. RN é tratado nos avisos como *"UF participante da SVRS"*.

## 2. MOC vigente

**Manual de Orientação do Contribuinte (MOC) versão 7.0** — confirmado como a versão vigente na listagem oficial `Documentos > Manuais` do Portal Nacional (não há MOC 8.0 publicado até a data desta pesquisa). Anexos relevantes: Anexo I (Leiaute e Regras de Validação), Anexo II (Especificações Técnicas DANFE — Código de Barras), Anexo III (Manual de Contingência NF-e), Anexo IV (Manual de Contingência NFC-e). **Data de publicação original do MOC 7.0 não confirmada diretamente** (a pesquisa confirmou que é a versão vigente hoje, sem abrir o PDF para checar a data de capa) — reconfirmar antes de citar formalmente.

## 3. Notas Técnicas — correção importante às premissas do pedido

| NT | Versão | Data (conforme portal) | Assunto real confirmado |
|---|---|---|---|
| **2025.002** | v.1.51 | 04/08/2026 (revisão ativa) | **Adequação dos leiautes de NF-e/NFC-e para a Reforma Tributária do Consumo (RTC)** — inclusão de campos/regras de IBS/CBS/IS. Esta é a NT relevante para IBS/CBS. |
| **2026.004** | v.1.01 | 08/06/2026 | ⚠️ **NÃO trata de Reforma Tributária.** Trata da **adequação ao CNPJ alfanumérico** (mudança da Receita Federal, tema separado). Se a expectativa interna era de que 2026.004 tratasse de IBS/CBS, essa premissa estava incorreta — corrigir na documentação interna. |

Outras NTs vigentes relevantes encontradas na mesma listagem oficial:
- **2026.007 v.1.00** (04/08/2026) — regras de validação para LCC-RFB/CCC (cadastro centralizado de contribuintes).
- **2026.002 v.1.10** (04/08/2026) — DANFE Simplificado Tipo 2 em vendas presenciais/não presenciais.
- **2026.001 v.1.02b** (31/07/2026) — Provedor de Assinatura e Autorização (PAA) — **relevante para avaliar futuramente se faz sentido delegar só a assinatura/transmissão a um provedor homologado, mantendo o resto sob controle próprio** — não avaliado nesta pesquisa, citado como pista para investigação futura, não como recomendação.
- **2023.003 v.1.30** (29/07/2026) — alterações de regras de validação (não especificado o conteúdo exato nesta pesquisa).
- **2014.002 v.1.40** (03/07/2026) — Web Service de distribuição de DF-e.

**Ação recomendada, não executada:** antes de fechar o modelo de dados de `fiscal_document_items`/`fiscal_tax_profiles` (Fase 1/2 já propostas em `fiscal-architecture-proposal.md`), ler o conteúdo completo da NT 2025.002 v.1.51 (não só o título) — ela está em revisão ativa, então uma leitura feita hoje pode já estar desatualizada amanhã. Monitorar continuamente.

## 4. Versão do schema XSD — desatualização de premissa

A premissa de "PL_009x" está desatualizada. Confirmado na listagem oficial `Documentos > Esquemas XML`:

| Pacote | Versão | Publicado |
|---|---|---|
| Schema dos eventos da NT 2025.002 | v.1.40 (RTC) | 27/07/2026 |
| Schemas XML NF-e | 010e_v.1.02 (NT 2025.002 v.1.40, NT 2026.002 v.1.0, NT 2026.003 v.1.0) | 10/07/2026 |
| Schemas XML NF-e — CNPJ Alfanumérico | 010d_v.1.03 (NT 2026.004 v.1.01) | 10/07/2026 |
| Pacote de Liberação — Distribuição de DF-e | v.1.04 | 03/07/2026 |

**O layout vigente é PL_010 (sub-revisões "d"/"e"), não PL_009x.** Download oficial: `nfe.fazenda.gov.br` > Documentos > Esquemas XML — nunca usar uma cópia de terceiro/cacheada. Ver [`fiscal-xsd-versioning-plan.md`](fiscal-xsd-versioning-plan.md) para a estratégia de manter isso atualizado ao longo do tempo.

## 5. Endpoints SVRS — NF-e

Fonte: `dfe-portal.svrs.rs.gov.br/Nfe/Servicos` (portal oficial SVRS, seção "Relação de Serviços Web"), confirmado ao vivo.

| Serviço | Versão | Produção | Homologação |
|---|---|---|---|
| `NfeStatusServico` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx` |
| `NFeAutorizacao` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx` |
| `NFeRetAutorizacao` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx` |
| `NfeConsultaProtocolo` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx` |
| `RecepcaoEvento` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx` |
| `NfeInutilizacao` | 4.00 | `https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx` | `https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx` |
| `NfeConsultaCadastro`* | 4.00 | `https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx` | (mesmo padrão de host `-homologacao`, não extraído literalmente nesta pesquisa — confirmar antes de codificar) |

*`NfeConsultaCadastro` só existe no bloco de serviços de **NF-e** — não tem equivalente no bloco de NFC-e (ver §6). Host diferente (`cad.svrs.rs.gov.br`, não `nfe.svrs.rs.gov.br`).

Para obter o WSDL de qualquer serviço acima: acrescentar `?wsdl` à URL.

## 6. Endpoints SVRS — NFC-e

| Serviço | Versão | Produção | Homologação |
|---|---|---|---|
| `NFeStatusServico` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx` |
| `NFeAutorizacao` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx` |
| `NFeRetAutorizacao` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx` |
| `NfeConsultaProtocolo` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx` |
| `RecepcaoEvento` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx` |
| `NfeInutilizacao` | 4.00 | `https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx` | `https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx` |

**Importante:** consulta de cadastro de contribuinte, quando necessária mesmo em fluxo de NFC-e, deve usar o webservice de **NF-e** (`cad.svrs.rs.gov.br`) — não existe um serviço equivalente sob o host de NFC-e.

## 7. Contingência de NFC-e (offline)

**Confirmado, com uma lacuna de detalhe.** Documento oficial: **"Manual de Especificações da Contingência Offline para NFC-e - versão 2.0"** (Portal Nacional, `Documentos > Manuais`). Confirmado também pela prática real do RN: em toda indisponibilidade do ambiente SVRS (manutenção programada ou falha), o próprio órgão fazendário do RN publica aviso instruindo que **NFC-e deve ser emitida em modalidade offline** — não existe ambiente alternativo online (tipo SVC) para NFC-e. **Não confirmado nesta pesquisa:** o conteúdo textual detalhado do manual v2.0 (prazo exato de regularização em horas, distinção formal entre indisponibilidade do estabelecimento vs. da SEFAZ). **Ação necessária antes de codificar:** baixar e ler o manual completo — a arquitetura de contingência já proposta em `fiscal-architecture-proposal.md` §6 foi desenhada em termos genéricos exatamente para não presumir esses detalhes; agora que a fonte primária foi localizada, o próximo passo é ler o texto completo antes de fechar os prazos/regras específicas no código.

## 8. Contingência de NF-e (SVC)

**Confirmado, incluindo qual SVC específico se aplica ao RN.** Nota Técnica fundadora: **2013.007 v.1.03**. Manual vigente: **"Manual de Contingência da NF-e - Versão 1.01"**. Para RN especificamente: os avisos oficiais confirmam que a contingência ativada é a **SVC-AN (SEFAZ Virtual de Contingência do Ambiente Nacional)** — não SVC-RS. Confirmado inclusive em um aviso histórico de calamidade pública do RS (03/05/2024), que ativou SVC-AN preventivamente "para as UF participantes da SVRS e para o próprio RS".

## 9. DANFE NFC-e e QR Code

**Confirmado com uma pendência de verificação.** Documento oficial: **"Manual de Padrões Técnicos do DANFE-NFC-e e QR Code - Versão 6.0 - Março de 2025"** (Portal Nacional, `Documentos > Manuais`). **Achado técnico relevante, não esperado, que precisa de ação antes de produção:** a URL de consulta pública de NFC-e do RN identificada nesta pesquisa (`https://nfce.set.rn.gov.br/portalDFE/NFCe/ConsultaNFCe.aspx`) apresentou **erro de certificado TLS** (o certificado servido é para `*.sefaz.rn.gov.br`, não para `nfce.set.rn.gov.br`) — indício de configuração desalinhada ou de que a URL correta/vigente mudou. **Bloqueador antes de gerar qualquer QR Code de produção:** validar manualmente com a SEFAZ/RN (ou com a contabilidade) qual é a URL de consulta pública correta e funcionando hoje — um erro aqui invalida a verificação pública de toda NFC-e emitida. Credenciamento e CSC são geridos pela **UVT (Unidade Virtual de Tributação)** do RN, confirmado via `uvt.sefaz.rn.gov.br`.

## 10. Reforma Tributária — cronograma oficial e achado decisivo para este projeto

**Confirmado em fonte oficial primária: Receita Federal, Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026**, em cumprimento ao art. 112 do Decreto nº 12.955/2026 e à Resolução CGIBS nº 06/2026.

| Data | Documentos obrigados |
|---|---|
| 03/08/2026 | BP-e (rodoviário), CT-e, NF-e, NFC-e, NF3e, MDF-e, GTV-e, DC-e, NFS-e Via — **regime geral** |
| 01/10/2026 | NFS-e (geral), NFCom, DeRE 1ª fase |
| 01/12/2026 | BP-e (aéreo/semiurbano), NF-e ABI, NFAg, NFGas, NFS-e Plataformas |
| **01/01/2027** | **"Documentos fiscais para contribuintes do Simples Nacional (NF-e, NFC-e, CT-e, NFS-e e outros)"** — leiaute específico a ser publicado em **01/09/2026** |

**Achado decisivo:** a Santtorini é Simples Nacional (contexto já registrado em `fiscal-audit-report.md`) — portanto **não está sob a obrigatoriedade de 03/08/2026**. O prazo real é **01/01/2027**, com o leiaute específico do Simples Nacional só sendo publicado em **01/09/2026**. **Isso não reduz a urgência da integração direta com a SEFAZ em si** (que é necessária independentemente da Reforma Tributária, só para emitir NF-e/NFC-e no leiaute atual) — mas **reduz a pressão de compliance de IBS/CBS especificamente**, dando uma janela real até setembro/2026 para o leiaute do Simples Nacional ser conhecido antes de qualquer campo de IBS/CBS precisar ser implementado com certeza. Recomenda-se não travar o cronograma de implementação (Entregas D-H em `fiscal-direct-implementation-phases.md`) esperando por essa clareza — a NFC-e no leiaute vigente pode e deve avançar em paralelo.

---

## Itens que precisam de reconfirmação manual antes de codificar (honestidade explícita)

1. Data exata de publicação do MOC 7.0.
2. Conteúdo textual completo do Manual de Contingência Offline NFC-e v2.0 (prazos exatos).
3. **URL de consulta pública de NFC-e do RN — erro de certificado TLS encontrado, precisa validação humana antes de qualquer QR Code de produção.**
4. Host exato de homologação de `NfeConsultaCadastro` (não extraído literalmente nesta pesquisa, só inferido por padrão).
5. Conteúdo completo e atualizado da NT 2025.002 (está em revisão ativa — v.1.51 hoje pode não ser a versão final).
