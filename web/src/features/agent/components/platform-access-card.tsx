/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import {
  Check,
  Clipboard,
  Download,
  ExternalLink,
  Laptop,
  Smartphone,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const API_ENDPOINT = 'https://api.lain42.top/v1'
const DESKTOP_DOWNLOAD_URL =
  'https://github.com/lilyco-42/new-api/releases/latest'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandaloneDisplayMode() {
  if (typeof window === 'undefined') return false

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari exposes this flag instead of display-mode.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function PlatformAccessCard() {
  const { t } = useTranslation()
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [showInstallHelp, setShowInstallHelp] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setInstalled(isStandaloneDisplayMode())

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const onAppInstalled = () => {
      setInstalled(true)
      setInstallPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  const handleInstall = async () => {
    if (!installPrompt) {
      setShowInstallHelp((visible) => !visible)
      return
    }

    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') {
      setInstalled(true)
    }
    setInstallPrompt(null)
  }

  const handleCopyEndpoint = async () => {
    if (!navigator.clipboard) return

    await navigator.clipboard.writeText(API_ENDPOINT)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Card size='sm'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Download className='text-primary size-4' />
          {t('Quick access on every device')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {t(
            'Use the browser, install a PWA, or download the Lain42 Agent desktop app.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
        <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-1'>
          <Button
            className='w-full justify-start'
            onClick={handleInstall}
            size='sm'
            variant={installed ? 'secondary' : 'outline'}
          >
            {installed ? <Check className='text-emerald-500' /> : <Download />}
            {installed ? t('Installed on this device') : t('Install as an app')}
          </Button>
          <Button
            className='w-full justify-start'
            render={
              <a href={DESKTOP_DOWNLOAD_URL} rel='noreferrer' target='_blank' />
            }
            size='sm'
            variant='outline'
          >
            <Laptop />
            {t('Download Lain42 Agent desktop app')}
            <ExternalLink className='ml-auto' />
          </Button>
        </div>

        {showInstallHelp && (
          <p className='text-muted-foreground rounded-lg border border-dashed p-2 text-xs leading-5'>
            {t(
              'Desktop: choose Install app from the address bar. iPhone or iPad: use Share → Add to Home Screen.'
            )}
          </p>
        )}

        <div className='grid gap-2 text-xs'>
          <div className='text-muted-foreground flex items-center gap-2'>
            <Laptop className='size-3.5' /> Windows · macOS · Linux
          </div>
          <div className='text-muted-foreground flex items-center gap-2'>
            <Smartphone className='size-3.5' /> Android · iOS · PWA
          </div>
          <div className='text-muted-foreground flex items-center gap-2'>
            <TerminalSquare className='size-3.5' />
            {t('OpenAI-compatible API clients')}
          </div>
        </div>

        <div className='border-border/60 bg-muted/20 flex items-center gap-2 rounded-lg border px-2.5 py-2'>
          <code className='min-w-0 flex-1 truncate text-[11px]'>
            {API_ENDPOINT}
          </code>
          <Button
            aria-label={t('Copy API endpoint')}
            onClick={handleCopyEndpoint}
            size='icon-xs'
            variant='ghost'
          >
            {copied ? <Check className='text-emerald-500' /> : <Clipboard />}
          </Button>
        </div>

        <Button
          className='w-full justify-start'
          render={<a href='/keys' />}
          size='sm'
          variant='ghost'
        >
          {t('Create an API key for external clients')}
          <ExternalLink className='ml-auto' />
        </Button>
      </CardContent>
    </Card>
  )
}
