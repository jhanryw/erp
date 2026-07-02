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

import { parseImportRows, type ImportRow, type ParsedProduct, type ErrorWarning, type DbData } from '@/lib/utils/import-parser'

export default function ImportarProdutosPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [file, setFile]           = useState<File | null>(null)
  const [loading, setLoading]     = useState(false)
  const [dbData, setDbData]       = useState<DbData | null>(null)
  const [rawRows, setRawRows]     = useState<any[]>([])

  const [parsedProducts, setParsedProducts] = useState<ParsedProduct[]>([])
  const [issues, setIssues]                 = useState<ErrorWarning[]>([])
  const [hasErrors, setHasErrors]           = useState(false)
  const [importing, setImporting]           = useState(false)
  const [importResult, setImportResult]     = useState<{
    imported: number
    serverError?: string
  } | null>(null)

  // Carregar dados de referência (categorias, fornecedores, variações, produtos existentes)
  useEffect(() => {
    async function loadDbData() {
      try {
        const [catsRes, suppRes, varsRes, namesRes] = await Promise.all([
          fetch('/api/categorias'),
          fetch('/api/fornecedores'),
          fetch('/api/variacoes'),
          fetch('/api/produtos/names'),
        ])
        const cats  = await catsRes.json()
        const supps = await suppRes.json()
        const vars  = await varsRes.json()
        const names = await namesRes.json()

        const types     = vars.types || []
        const colorType = types.find((t: any) => t.slug === 'cor')
        const sizeType  = types.find((t: any) => t.slug === 'tamanho')

        setDbData({
          categories:       cats.categories  ?? [],
          suppliers:        supps.suppliers  ?? [],
          colors:           colorType?.variation_values ?? [],
          sizes:            sizeType?.variation_values  ?? [],
          existingProducts: names.products   ?? [],
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

  useEffect(() => {
    if (rawRows.length === 0 || !dbData) return
    setLoading(true)
    const { parsedProducts: pp, issues: iss, hasErrors: he } = parseImportRows(rawRows, dbData)
    setParsedProducts(pp)
    setIssues(iss)
    setHasErrors(he)
    setLoading(false)
  }, [rawRows, dbData])

  async function handleImport() {
    if (hasErrors || parsedProducts.length === 0) return

    setImporting(true)
    setImportResult(null)

    try {
      const res  = await fetch('/api/produtos/import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(parsedProducts),
      })
      const json = await res.json()

      if (res.ok) {
        setImportResult({ imported: json.imported ?? parsedProducts.length })
        toast.success(`${json.imported} produto${json.imported !== 1 ? 's' : ''} importado${json.imported !== 1 ? 's' : ''} com sucesso!`)
        router.push('/produtos')
        router.refresh()
      } else {
        // 400: validação backend falhou (produto criado depois da validação frontend, por ex.)
        // 422 ou 500: erro inesperado
        const errorMsg  = json.error ?? 'Erro desconhecido'
        const extraList: string[] = json.validationErrors ?? []
        const fullMsg   = extraList.length > 0
          ? `${errorMsg}\n${extraList.join('\n')}`
          : errorMsg

        setImportResult({ imported: 0, serverError: fullMsg })
        toast.error('Importação bloqueada pelo servidor', { description: errorMsg })
      }
    } catch {
      setImportResult({ imported: 0, serverError: 'Falha de rede ao enviar os dados.' })
      toast.error('Falha inesperada ao importar')
    } finally {
      setImporting(false)
    }
  }

  const errors   = issues.filter(i => i.type === 'error')
  const warnings = issues.filter(i => i.type === 'warning')
  const canImport = !loading && !importing && !hasErrors && parsedProducts.length > 0

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
            para garantir que as colunas estejam corretas. Colunas: nome_produto, tipo, modelo, ano,
            categoria, cor, tamanho, preco, custo, estoque_inicial.
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
              ) : parsedProducts.length === 0 ? (
                <span className="text-text-muted">Nenhum produto encontrado no arquivo</span>
              ) : (
                <span className="text-text-secondary">
                  <strong className="text-text-primary">{parsedProducts.length}</strong>{' '}
                  produto{parsedProducts.length !== 1 ? 's' : ''} prontos para importar
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
            <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10 border border-success/20">
              <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
              <div>
                <p className="font-semibold text-success text-lg">{importResult.imported} produto{importResult.imported !== 1 ? 's' : ''} importado{importResult.imported !== 1 ? 's' : ''}</p>
                <p className="text-sm text-text-muted">Redirecionando para a lista de produtos…</p>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
