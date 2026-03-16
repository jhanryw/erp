import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from 'sonner'
import { Providers } from './providers'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: {
    default: 'Santtorini ERP',
    template: '%s | Santtorini ERP',
  },
  description: 'Sistema de gestão interno Santtorini',
  robots: 'noindex, nofollow',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className={`${inter.variable} font-sans`}>
        <Providers>
          {children}
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              classNames: {
                toast: 'bg-bg-elevated border border-border text-text-primary',
                description: 'text-text-secondary',
                actionButton: 'bg-brand text-white',
                cancelButton: 'bg-bg-overlay text-text-secondary',
                error: 'border-error/30 bg-error/10',
                success: 'border-success/30 bg-success/10',
              },
            }}
          />
        </Providers>
      </body>
    </html>
  )
}
