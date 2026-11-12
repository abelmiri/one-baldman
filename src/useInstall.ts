import { useEffect, useRef, useState } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const standalone = () => window.matchMedia('(display-mode: standalone)').matches
  || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)

export function useInstall() {
  const pending = useRef<InstallPrompt | null>(null)
  const [installed, setInstalled] = useState(standalone)
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [message, setMessage] = useState('')
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)')
    const sync = () => setInstalled(standalone())
    const capture = (event: Event) => {
      event.preventDefault()
      pending.current = event as InstallPrompt
      setAvailable(true)
      setMessage('')
    }
    const complete = () => {
      pending.current = null
      setAvailable(false)
      setInstalled(true)
      setHelp(false)
    }
    window.addEventListener('beforeinstallprompt', capture)
    window.addEventListener('appinstalled', complete)
    media.addEventListener('change', sync)
    return () => {
      window.removeEventListener('beforeinstallprompt', capture)
      window.removeEventListener('appinstalled', complete)
      media.removeEventListener('change', sync)
    }
  }, [])

  const install = async () => {
    const prompt = pending.current
    if (!prompt) { setHelp(current => !current); return }
    setBusy(true)
    setMessage('')
    pending.current = null
    setAvailable(false)
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') setHelp(false)
    } catch {
      setHelp(true)
      setMessage('پنجرهٔ نصب باز نشد؛ از منوی مرورگر نصب کنید.')
    } finally { setBusy(false) }
  }

  return { installed, available, busy, help, message, ios, install }
}
