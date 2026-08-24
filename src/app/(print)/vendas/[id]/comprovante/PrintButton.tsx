'use client'

export function PrintButton() {
  return (
    <button className="btn-print" type="button" onClick={() => window.print()}>
      🖨️ Imprimir
    </button>
  )
}
