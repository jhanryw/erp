import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Guarda de contraste (WCAG AA) do site público: impede a volta de classes que falham 4,5:1 / 3:1 sobre branco.
 * Cinza-300 (1,5:1) e cinza-400 (2,5:1) só são aceitos em estado desabilitado (exento de contraste) e em ícones de imagem ausente.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

const files = sources(path.join(process.cwd(), 'src/app/atacado'))

describe('contraste do site de atacado', () => {
  it('nenhum TEXTO usa cinza-300/400, âmbar-600 ou vermelho-500 (abaixo de 4,5:1)', () => {
    const offenders: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/text-gray-(300|400)\b|text-amber-[1-6]00\b|text-red-[1-5]00\b|placeholder:text-gray-[1-4]00/.test(line) && !/ImageOff|disabled/.test(line)) {
          offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('botão com texto branco nunca usa o verde #25D366 (1,98:1)', () => {
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain('#25D366')
  })

  it('o layout força tema claro e cor de texto explícita', () => {
    const layout = readFileSync(path.join(process.cwd(), 'src/app/atacado/layout.tsx'), 'utf8')
    expect(layout).toContain('text-gray-900')
    expect(layout).toContain("colorScheme: 'light'")
  })
})
