import { useEffect, useRef, useState } from 'react'
import type { ClothLab, CameraView, FlightTelemetry, Settings } from './ClothLab'
import { useInstall } from './useInstall'
import GameHUD from './GameHUD'
import Wings from './Wings'

const initial: Settings = {
  mode: 'cape', wind: 2, windDirection: 90, gravity: 9.8, stiffness: 32,
  playing: true, standing: true, gait: 'walk', sitting: false,
}

export default function App() {
  const host = useRef<HTMLDivElement>(null)
  const lab = useRef<ClothLab | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const [view, setView] = useState<CameraView>('player')
  const [night, setNight] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const telemetrySink = useRef<(telemetry: FlightTelemetry) => void>(() => {})
  const install = useInstall()

  useEffect(() => {
    let cancelled = false
    let game: ClothLab | null = null
    // Paint the loading UI before downloading and initializing the engine/WASM.
    void import('./ClothLab').then(({ ClothLab }) => {
      if (cancelled || !host.current) return
      game = new ClothLab(host.current, initial, undefined, telemetry => telemetrySink.current(telemetry), () => setMenu(true))
      lab.current = game
      setReady(true)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
      game?.dispose()
      if (lab.current === game) lab.current = null
    }
  }, [])

  useEffect(() => {
    lab.current?.update({ ...initial, playing: !menu })
    if (menu) dialog.current?.focus()
    else lab.current?.focusGame()
  }, [menu, ready])
  useEffect(() => { lab.current?.setCameraView(view) }, [view, ready])
  useEffect(() => { lab.current?.setNight(night) }, [night, ready])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code === 'Escape' && !event.repeat) {
        event.preventDefault()
        setMenu(current => !current)
      }
      if (event.code === 'Tab' && dialog.current) {
        const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
          event.preventDefault(); first?.focus()
        }
      }
    }
    const visibility = () => { if (document.hidden) setMenu(true) }
    const blur = () => setMenu(true)
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement))
    window.addEventListener('keydown', keydown)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('fullscreenchange', syncFullscreen)
    }
  }, [])

  const resumeGame = (nextView: CameraView = view) => {
    if (nextView !== view) lab.current?.setCameraView(nextView)
    lab.current?.update({ ...initial, playing: true })
    if (window.matchMedia('(pointer: fine)').matches) lab.current?.lockPointer()
    setView(nextView)
    setMenu(false)
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch { setError('حالت تمام‌صفحه در این مرورگر در دسترس نیست.') }
  }

  return <main className={`game-shell ${!menu && view === 'player' ? 'is-mouse-look' : ''}`}>
    <section className="game-world" aria-label="بازی نگهبان شهر">
      <div ref={host} className="canvas-host" />
      <div className="game-vignette" aria-hidden="true" />
      {!menu && view === 'player' && <div className="aim-reticle" aria-hidden="true"><i /></div>}
      {!menu && view === 'player' && <div className="mouse-look-hint">برای کنترل دوربین با موس، روی صحنه کلیک کنید <span>·</span> <kbd>ESC</kbd> منو</div>}
    </section>

    <div className="game-interface" inert={menu || !ready}>
    <header className="game-header">
      <div className="game-brand"><img src="/icons/icon-192.png" width="52" height="52" alt="" /><div><span className="brand-overline">COASTAL CITY</span><strong>نگهبان شهر</strong></div></div>
      <div className="patrol-status"><i /><span>{view === 'city' ? 'نقشهٔ شهر' : 'گشت آزاد'}</span><span className="status-divider" />{night ? 'شب' : 'روز'}</div>
      <div className="header-actions">
      {!install.installed && <button className="install-trigger" type="button" disabled={install.busy} onClick={() => { setMenu(true); void install.install() }}>↓ <span>نصب بازی</span></button>}
      <button className="menu-trigger" type="button" aria-label="باز کردن منوی بازی" aria-haspopup="dialog" aria-expanded={menu}
        onClick={() => setMenu(true)}><span className="menu-lines" aria-hidden="true" /><span>منو</span><kbd>ESC</kbd></button>
      </div>
    </header>

    {view === 'city' && <button className="return-to-player" type="button" onClick={() => resumeGame('player')}>↗ بازگشت به شخصیت</button>}

    <GameHUD lab={lab} telemetrySink={telemetrySink} ready={ready} menu={menu} />

    </div>

    {menu && <div className="pause-overlay">
      <div className="pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title" ref={dialog} tabIndex={-1}>
        <button type="button" className="close-menu" aria-label="بستن منو" onClick={() => resumeGame()}>×</button>
        <Wings className="pause-emblem" /><span className="pause-overline">PATROL ON HOLD</span>
        <h1 id="pause-title">شهر منتظر توست.</h1><p>نفسی تازه کن؛ گشت هنوز ادامه دارد.</p>
        <button className="resume-button" type="button" onClick={() => resumeGame()}>ادامهٔ بازی <span aria-hidden="true">←</span></button>
        <div className="menu-options">
          {!install.installed && <button type="button" onClick={install.install} disabled={install.busy} aria-expanded={install.help} aria-controls={install.help ? 'install-help' : undefined}>
            <span className="option-icon" aria-hidden="true">↓</span><span>{install.busy ? 'در حال باز کردن نصب…' : install.available ? 'نصب بازی روی دستگاه' : 'راهنمای نصب بازی'}</span><span className="option-detail" aria-hidden="true">↗</span>
          </button>}
          {!install.installed && install.help && <div className="install-help" id="install-help" role="status">
            <strong>نگهبان شهر، روی صفحهٔ اصلی</strong>
            {install.message && <p>{install.message}</p>}
            {install.ios ? <p>در مرورگر، منوی اشتراک‌گذاری (Share) را باز کنید و «افزودن به صفحهٔ اصلی» (Add to Home Screen) را بزنید. اگر «باز کردن به‌صورت برنامه» (Open as Web App) دیده می‌شود، آن را روشن کنید و «افزودن» را بزنید.</p>
              : <p>از منوی مرورگر، «نصب برنامه» (Install app) یا «افزودن به صفحهٔ اصلی» (Add to Home Screen) را انتخاب کنید. در Safari مک، گزینهٔ «افزودن به Dock» در منوی File است. اگر گزینهٔ نصب دیده نمی‌شود، بازی را در Chrome، Edge یا Safari باز کنید.</p>}
          </div>}
          <button type="button" onClick={() => resumeGame(view === 'city' ? 'player' : 'city')}>
            <span className="option-icon" aria-hidden="true">⌖</span><span>{view === 'city' ? 'بازگشت به شخصیت' : 'نقشهٔ شهر'}</span><span className="option-detail" aria-hidden="true">↗</span>
          </button>
          <button type="button" role="switch" aria-checked={night} onClick={() => setNight(current => !current)}>
            <span className="option-icon" aria-hidden="true">☾</span><span>حالت شب</span><span className={`game-switch ${night ? 'on' : ''}`}><i /></span>
          </button>
          {document.fullscreenEnabled && <button type="button" onClick={toggleFullscreen}>
            <span className="option-icon" aria-hidden="true">⛶</span><span>{fullscreen ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه'}</span><span className="option-detail" aria-hidden="true">↗</span>
          </button>}
          <button type="button" onClick={() => { lab.current?.reset(); resumeGame('player') }}>
            <span className="option-icon" aria-hidden="true">↻</span><span>شروع مجدد</span><span className="option-detail" aria-hidden="true">↗</span>
          </button>
        </div>
        <div className="menu-guide"><span>کلیک روی صحنه؛ حرکت موس برای چرخش دوربین</span><span><kbd>ESC</kbd> آزاد کردن موس و منو</span><span><kbd>SPACE</kbd> برخاستن و صعود؛ رهاکردن برای شناوری</span><span><kbd>W</kbd> پرواز در جهت موس؛ WASD حرکت</span><span><kbd>SHIFT + W</kbd> پرواز با سرعت ۱۰ برابر</span><span><kbd>C</kbd> پایین آمدن و فرود</span><span><kbd>F</kbd> نگه‌داشتن برای لیزر چشم</span><span><kbd>X</kbd> رهاشدن بدن / بازگشت کنترل و بلندشدن</span></div>
        <span className="pause-footer">COASTAL CITY <i /> FREE ROAM</span>
      </div>
    </div>}

    {!ready && <div className="game-loading"><Wings /><strong>{error ? 'بارگذاری انجام نشد' : 'در حال آماده‌سازی شهر'}</strong><span>{error || 'گشت تو به‌زودی شروع می‌شود…'}</span></div>}
    {ready && error && <button type="button" className="game-notice" onClick={() => setError('')}>{error} ×</button>}
  </main>
}
