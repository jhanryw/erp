import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from 'sonner'
import { Providers } from './providers'
import { ServiceWorkerRegistration } from '@/components/push/ServiceWorkerRegistration'

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
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Santtorini',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: 'cover',
  },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className={`${inter.variable} font-sans`}>
        <ServiceWorkerRegistration />
        <Providers>
          {children}
          <Toaster
            theme="system"
            position="bottom-right"
            toastOptions={{
              classNames: {
                toast:        'bg-bg-elevated border border-border text-text-primary',
                description:  'text-text-secondary',
                actionButton: 'bg-brand text-white',
                cancelButton: 'bg-bg-overlay text-text-secondary',
                error:        'border-error/30 bg-error/10',
                success:      'border-success/30 bg-success/10',
              },
            }}
          />
        </Providers>
      </body>
    </html>
  )
}
