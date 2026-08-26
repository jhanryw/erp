'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import * as xlsx from 'xlsx'
import Papa from 'papaparse'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  ArrowLeft, Upload, FileType, Check, AlertTriangle,
  AlertCircle, RefreshCw, CheckCircle2, XCircle,
} from 'lucide-react'

import { parseImportRows, type ImportRow, type ParsedProduct, type ParsedProductUpdate, type ErrorWarning, type DbData } from '@/lib/utils/import-parser'
import { matchProductType, type ModeloGovernance } from '@/lib/sku/resolve-taxonomy'

export default function ImportarProdutosPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [file, setFile]           = useState<File | null>(null)
  const [loading, setLoading]     = useState(false)
  const [dbData, setDbData]       = useState<DbData | null>(null)
  const [rawRows, setRawRows]     = useState<any[]>([])

  const [parsedProducts, setParsedProducts] = useState<ParsedProduct[]>([])
  // Conclusão da fundação varejo/atacado (2026-09-01) — linhas com SKU
  // preenchido (atualização de produto/variação existente).
  const [parsedUpdates, setParsedUpdates] = useState<ParsedProductUpdate[]>([])
  const [issues, setIssues]                 = useState<ErrorWarning[]>([])
  const [hasErrors, setHasErrors]           = useState(false)
  const [importing, setImporting]           = useState(false)
  // Uma chave por lote validado (não por clique) — retries do MESMO lote
  // (ex.: erro de rede, o usuário clica "Importar" de novo) reusam a
  // mesma chave, permitindo que a RPC detecte repetição e não duplique
  // produtos. Um novo arquivo/nova validação gera uma chave nova.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [importResult, setImportResult]     = useState<{
    created: number
    updated: number
    updateErrors: Array<{ client_index: number; sku: string | null; message: string }>
    updateBlockedError?: string
    serverError?: string
  } | null>(null)

  // Carregar dados de referência (categorias, fornecedores, variações, produtos
  // existentes, Tipos ativos do PIM). Governança de Modelo por Tipo é
  // buscada à parte, sob demanda, quando o CSV é carregado — só para os
  // Tipos realmente presentes no arquivo (ver useEffect de rawRows abaixo).
  useEffect(() => {
    async function loadDbData() {
      try {
        const [catsRes, suppRes, varsRes, namesRes, tiposRes] = await Promise.all([
          fetch('/api/categorias'),
          fetch('/api/fornecedores'),
          fetch('/api/variacoes'),
          fetch('/api/produtos/names'),
          fetch('/api/produtos/tipos'),
        ])
        const cats  = await catsRes.json()
        const supps = await suppRes.json()
        const vars  = await varsRes.json()
        const names = await namesRes.json()
        const tipos = await tiposRes.json()

        const types     = vars.types || []
        const colorType = types.find((t: any) => t.slug === 'cor')
        const sizeType  = types.find((t: any) => t.slug === 'tamanho')

        setDbData({
          categories:       cats.categories  ?? [],
          suppliers:        supps.suppliers  ?? [],
          colors:           colorType?.variation_values ?? [],
          sizes:            sizeType?.variation_values  ?? [],
          existingProducts: names.products   ?? [],
          productTypes:     tipos.product_types ?? [],
          modeloGovernanceByTipoSlug: {},
          modeloExplicitlyNotUsedTipoSlugs: new Set(),
        })
      } catch {
        toast.error('Erro ao carregar dados do sistema')
      }
    }
    loadDbData()
  }, [])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setParsedProducts([])
    setParsedUpdates([])
    setIssues([])
    setHasErrors(false)
    setRawRows([])
    setImportResult(null)

    const isCsv = selected.name.toLowerCase().endsWith('.csv')
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (!result) return

      if (isCsv) {
        Papa.parse(selected, {
          header: true,
          skipEmptyLines: true,
          complete: (r) => setRawRows(r.data as any[]),
        })
      } else {
        const wb = xlsx.read(result, { type: 'buffer' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        setRawRows(xlsx.utils.sheet_to_json(ws) as any[])
      }
    }

    if (isCsv) reader.readAsText(selected)
    else        reader.readAsArrayBuffer(selected)
  }

  // Antes de validar, busca a governança de Modelo (type_attribute_values)
  // só dos Tipos realmente presentes no CSV, via /api/produtos/modelo-options
  // — mesma fonte usada pelo cadastro manual e pela importação definitiva no
  // servidor (nenhuma regra de governança nova aqui). Só então roda
  // parseImportRows, que usa resolveTipoModelo (mesma função do servidor)
  // para validar Tipo/Modelo — garante que a prévia nunca aceita algo que o
  // servidor rejeitaria depois.
  useEffect(() => {
    if (rawRows.length === 0 || !dbData) return
    let cancelled = false
    setLoading(true)

    async function run() {
      const distinctTipoInputs = Array.from(
        new Set(rawRows.map(r => String(r.tipo || '').trim()).filter(Boolean))
      )

      const modeloGovernanceByTipoSlug: Record<string, ModeloGovernance> = {}
      const modeloExplicitlyNotUsedTipoSlugs = new Set<string>()

      await Promise.all(distinctTipoInputs.map(async (tipoInput) => {
        const match = matchProductType(tipoInput, dbData!.productTypes)
        if (!match || modeloGovernanceByTipoSlug[match.slug] || modeloExplicitlyNotUsedTipoSlugs.has(match.slug)) return

        try {
          const res  = await fetch(`/api/produtos/modelo-options?tipo=${encodeURIComponent(match.slug)}`)
          const json = await res.json()
          if (json.governed) {
            modeloGovernanceByTipoSlug[match.slug] = {
              required: !!json.required,
              values: (json.values ?? []).map((v: any) => ({
                id: v.id, value: v.value, slug: v.slug, sku_code: v.sku_code,
              })),
            }
          } else if (json.configured) {
            // type_attributes existe pra este Tipo porém inativo — sinal
            // explícito de "não usa Modelo codificado" (não confundir com
            // "nunca configurado", que cai no mapa legado ou em erro).
            modeloExplicitlyNotUsedTipoSlugs.add(match.slug)
          }
        } catch {
          // Falha de rede — Tipo fica sem governança carregada; resolveTipoModelo
          // tenta o mapa legado e, se também não encontrar, reporta erro de
          // configuração (nunca aceita por omissão).
        }
      }))

      if (cancelled) return

      const { parsedProducts: pp, parsedUpdates: pu, issues: iss, hasErrors: he } = parseImportRows(
        rawRows,
        { ...dbData!, modeloGovernanceByTipoSlug, modeloExplicitlyNotUsedTipoSlugs },
      )
      setParsedProducts(pp)
      setParsedUpdates(pu)
      setIssues(iss)
      setHasErrors(he)
      setIdempotencyKey(crypto.randomUUID())
      setLoading(false)
    }

    run()
    return () => { cancelled = true }
  }, [rawRows, dbData])

  async function handleImport() {
    if (hasErrors || (parsedProducts.length === 0 && parsedUpdates.length === 0)) return

    console.info('[IMPORT] botao clicado', { criar: parsedProducts.length, atualizar: parsedUpdates.length, idempotencyKey })

    setImporting(true)
    setImportResult(null)

    try {
      console.info('[IMPORT] enviando fetch')
      const res  = await fetch('/api/produtos/import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          products: parsedProducts,
          updates:  parsedUpdates,
          idempotency_key: idempotencyKey ?? undefined,
        }),
      })
      const json = await res.json()

      console.info('[IMPORT] resposta recebida', {
        status: res.status, ok: res.ok, created: json.created, updated: json.updated,
      })

      const created      = typeof json.created === 'number' ? json.created : 0
      const updated       = typeof json.updated === 'number' ? json.updated : 0
      const updateErrors: Array<{ client_index: number; sku: string | null; message: string }> = Array.isArray(json.update_errors) ? json.update_errors : []

      // Nunca tratar como sucesso só por causa de res.ok — as RPCs podem
      // devolver 2xx num replay idempotente ou com contagem inconsistente.
      // Só é sucesso real (parcial ou total) se created/updated vierem
      // acompanhados da lista correspondente, com a MESMA contagem.
      const createdConfirmed = created > 0 && Array.isArray(json.created_products) && json.created_products.length === created
      const updatedConfirmed = updated > 0 && Array.isArray(json.updated_products) && json.updated_products.length === updated

      if (createdConfirmed || updatedConfirmed) {
        setImportResult({ created, updated, updateErrors, updateBlockedError: json.update_blocked_error ?? undefined })
        const parts: string[] = []
        if (created > 0) parts.push(`${created} criado${created !== 1 ? 's' : ''}`)
        if (updated > 0) parts.push(`${updated} atualizado${updated !== 1 ? 's' : ''}`)
        if (updateErrors.length > 0) parts.push(`${updateErrors.length} erro${updateErrors.length !== 1 ? 's' : ''}`)
        toast.success(`Importação concluída: ${parts.join(', ')}`)
        router.push('/produtos')
        router.refresh()
      } else if (res.ok) {
        console.warn('[IMPORT] resposta ok porem sem confirmacao valida', { created, updated })
        const errorMsg = json.create_error?.message ?? json.update_blocked_error
          ?? `O servidor respondeu sem confirmar nenhuma criação/atualização.`
        setImportResult({ created: 0, updated: 0, updateErrors, serverError: errorMsg })
        toast.error('Importação não confirmada pelo servidor', { description: errorMsg })
      } else {
        // 400/422/500: nada foi criado nem atualizado
        const errorMsg  = json.create_error?.message ?? json.update_blocked_error ?? json.error ?? 'Erro desconhecido'
        const extraList: string[] = json.create_error?.validationErrors ?? []
        // Mostra code/details/hint do Postgres na tela (não só no console
        // do servidor) — a mensagem de erro já vem com o nome do produto e
        // a posição no lote que falhou (ver rpc_import_products_batch).
        const pgDebugLines = [
          json.create_error?.code    ? `code: ${json.create_error.code}`       : null,
          json.create_error?.details ? `details: ${json.create_error.details}` : null,
          json.create_error?.hint    ? `hint: ${json.create_error.hint}`       : null,
        ].filter(Boolean)
        const fullMsg   = [errorMsg, ...extraList, ...pgDebugLines].join('\n')

        setImportResult({ created: 0, updated: 0, updateErrors, serverError: fullMsg })
        toast.error('Importação bloqueada pelo servidor', { description: errorMsg })
      }
    } catch (e) {
      console.error('[IMPORT] excecao no fetch', e)
      setImportResult({ created: 0, updated: 0, updateErrors: [], serverError: 'Falha de rede ao enviar os dados.' })
      toast.error('Falha inesperada ao importar')
    } finally {
      setImporting(false)
    }
  }

  const errors   = issues.filter(i => i.type === 'error')
  const warnings = issues.filter(i => i.type === 'warning')
  const canImport = !loading && !importing && !hasErrors && (parsedProducts.length > 0 || parsedUpdates.length > 0)

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/produtos">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Importar Produtos</h2>
          <p className="text-sm text-text-muted">Importação em lote via CSV ou XLSX — todos os produtos ou nenhum</p>
        </div>
      </div>

      <Card className="p-6">
        <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-border rounded-lg bg-bg-overlay/50">
          <FileType className="w-10 h-10 text-text-muted mb-4" />
          <p className="font-medium text-text-primary mb-2">Selecione ou arraste seu arquivo</p>
          <p className="text-sm text-text-muted text-center mb-6 max-w-md">
            Faça download do{' '}
            <a href="/template-importacao.csv" className="text-brand hover:underline">template em CSV</a>{' '}
            para garantir que as colunas estejam corretas.
            <br />
            <strong>Criar produto:</strong> nome_produto, tipo, modelo, ano, categoria, fornecedor, origem,
            cor, tamanho, preco, custo, estoque_inicial, ativo, preco_atacado, ncm, origem_fiscal, cst
            (os 4 últimos são opcionais).
            <br />
            <strong>Atualizar produto existente:</strong> preencha a coluna <code>sku</code> com o SKU da
            variação (não recria o produto) e informe só as colunas que quer alterar — preco, preco_atacado,
            ncm, origem_fiscal, cst. Célula vazia nunca apaga o valor já cadastrado.
          </p>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
            onChange={handleFileSelect}
          />
          <Button onClick={() => fileInputRef.current?.click()} variant="outline">
            <Upload className="w-4 h-4 mr-2" />
            {file ? file.name : 'Selecionar arquivo'}
          </Button>
        </div>
      </Card>

      {file && (
        <Card className="p-6 space-y-6">
          <h3 className="text-lg font-medium border-b border-border pb-2">Avaliação do Arquivo</h3>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center">
              <p className="text-3xl font-semibold mb-1">{rawRows.length}</p>
              <p className="text-xs text-text-muted uppercase tracking-wider">Linhas no CSV</p>
            </div>
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center flex flex-col items-center justify-center">
              <p className={`text-3xl font-semibold mb-1 ${errors.length > 0 ? 'text-error' : 'text-text-primary'}`}>
                {errors.length}
              </p>
              <p className={`text-xs uppercase tracking-wider flex items-center gap-1 ${errors.length > 0 ? 'text-error/80' : 'text-text-muted'}`}>
                <AlertCircle className="w-3 h-3" /> Erros
              </p>
            </div>
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center flex flex-col items-center justify-center">
              <p className="text-3xl font-semibold mb-1 text-warning">{warnings.length}</p>
              <p className="text-xs text-warning/80 uppercase tracking-wider flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Avisos
              </p>
            </div>
          </div>

          {/* Issues table */}
          {issues.length > 0 && (
            <div className="space-y-4">
              <h4 className="font-medium">Detalhamento de problemas:</h4>
              <div className="space-y-2">
                {(() => {
                  // Group by normalized message key
                  const grouped = new Map<string, { type: 'error' | 'warning'; rows: number[]; sample: string }>()
                  issues.forEach(issue => {
                    const key = issue.message.replace(/'[^']*'/g, "'…'")
                    if (!grouped.has(key)) grouped.set(key, { type: issue.type, rows: [], sample: issue.message })
                    grouped.get(key)!.rows.push(issue.row)
                  })
                  return Array.from(grouped.entries()).map(([key, { type, rows, sample }]) => (
                    <div
                      key={key}
                      className={`p-3 rounded-md text-sm border flex items-start gap-3 ${
                        type === 'error'
                          ? 'bg-error/10 border-error/20'
                          : 'bg-warning/10 border-warning/20'
                      }`}
                    >
                      {type === 'error'
                        ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-error" />
                        : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />}
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium ${type === 'error' ? 'text-error' : 'text-warning-foreground'}`}>
                          {sample}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {rows.length === 1
                            ? `Linha ${rows[0]}`
                            : `${rows.length} linhas afetadas — primeiras: ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? '…' : ''}`}
                        </p>
                      </div>
                      {rows.length > 1 && (
                        <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
                          type === 'error' ? 'bg-error/20 text-error' : 'bg-warning/20 text-warning-foreground'
                        }`}>
                          ×{rows.length}
                        </span>
                      )}
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}

          {/* Footer: status message + import button */}
          <div className="flex items-center justify-between pt-4 border-t border-border gap-4">
            <div className="text-sm">
              {hasErrors ? (
                <span className="flex items-center gap-2 text-error font-medium">
                  <XCircle className="w-4 h-4" />
                  Corrija os erros acima antes de importar
                </span>
              ) : parsedProducts.length === 0 && parsedUpdates.length === 0 ? (
                <span className="text-text-muted">Nenhum produto encontrado no arquivo</span>
              ) : (
                <span className="text-text-secondary">
                  {parsedProducts.length > 0 && (
                    <><strong className="text-text-primary">{parsedProducts.length}</strong>{' '}produto{parsedProducts.length !== 1 ? 's' : ''} para criar</>
                  )}
                  {parsedProducts.length > 0 && parsedUpdates.length > 0 && ' · '}
                  {parsedUpdates.length > 0 && (
                    <><strong className="text-text-primary">{parsedUpdates.length}</strong>{' '}para atualizar</>
                  )}
                  {warnings.length > 0 && (
                    <span className="text-warning ml-2">· {warnings.length} aviso{warnings.length !== 1 ? 's' : ''}</span>
                  )}
                </span>
              )}
            </div>
            <Button onClick={handleImport} disabled={!canImport}>
              {importing
                ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                : <Check className="w-4 h-4 mr-2" />}
              Importar produtos
            </Button>
          </div>
        </Card>
      )}

      {/* Resultado da importação */}
      {importResult && (
        <Card className="p-6 space-y-4">
          <h3 className="text-lg font-medium border-b border-border pb-2">Resultado</h3>

          {importResult.serverError ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-error/10 border border-error/20">
                <XCircle className="w-6 h-6 text-error shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium text-error">Importação bloqueada pelo servidor</p>
                  <p className="text-sm text-text-secondary mt-1 whitespace-pre-line">{importResult.serverError}</p>
                  <p className="text-xs text-text-muted mt-2">Nenhum produto foi salvo. Corrija o arquivo e tente novamente.</p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => setImportResult(null)}>Fechar</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10 border border-success/20">
                <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
                <div>
                  <p className="font-semibold text-success text-lg">
                    Importação concluída: {importResult.created} criado{importResult.created !== 1 ? 's' : ''}, {importResult.updated} atualizado{importResult.updated !== 1 ? 's' : ''}
                    {importResult.updateErrors.length > 0 && `, ${importResult.updateErrors.length} erro${importResult.updateErrors.length !== 1 ? 's' : ''}`}
                  </p>
                  <p className="text-sm text-text-muted">Redirecionando para a lista de produtos…</p>
                </div>
              </div>

              {importResult.updateBlockedError && (
                <div className="p-3 rounded-md text-sm bg-error/10 border border-error/20 text-error">
                  Atualizações não puderam ser processadas: {importResult.updateBlockedError}
                </div>
              )}

              {importResult.updateErrors.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-text-primary">Linhas com erro na atualização:</p>
                  {importResult.updateErrors.map((err, i) => (
                    <div key={i} className="p-3 rounded-md text-sm bg-error/10 border border-error/20 flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-error" />
                      <div className="min-w-0">
                        <p className="text-error">SKU: {err.sku ?? '(vazio)'}</p>
                        <p className="text-text-secondary">{err.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
