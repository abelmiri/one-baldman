import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ClothLab, type Mode, type Settings } from './ClothLab'
import './style.css'

const initial: Settings = {
  mode: 'hanging', wind: 4, windDirection: 90, gravity: 9.8, stiffness: 32, playing: true,
}

function Slider({ label, value, min, max, step, unit = '', onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string;
  onChange: (value: number) => void
}) {
  return <label className="slider-row">
    <span className="slider-heading"><span>{label}</span><output dir="ltr">{value}{unit}</output></span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(event) => onChange(Number(event.target.value))} />
  </label>
}

function App() {
  const host = useRef<HTMLDivElement>(null)
  const lab = useRef<ClothLab | null>(null)
  const [settings, setSettings] = useState<Settings>(initial)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    try {
      if (!cancelled && host.current) {
        lab.current = new ClothLab(host.current, initial)
        setReady(true)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    return () => {
      cancelled = true
      lab.current?.dispose()
      lab.current = null
    }
  }, [])

  useEffect(() => { lab.current?.update(settings) }, [settings])

  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }))

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>آزمایشگاه پارچه</span></div>
      <div className="topbar-note"><span className="live-dot" /> شبیه‌سازی زنده با Rapier</div>
    </header>

    <div className="workspace">
      <aside className="panel" aria-label="کنترل‌های شبیه‌ساز">
        <div className="panel-intro">
          <span className="eyebrow">CLOTH LAB / 01</span>
          <h1>پارچه در حرکت</h1>
          <p>باد، گرانش و برخورد را تغییر دهید و رفتار پارچه را همان لحظه ببینید.</p>
        </div>

        <div className="control-group">
          <span className="group-label">حالت صحنه</span>
          <div className="segmented" role="group" aria-label="حالت صحنه">
            {([['hanging', 'آویزان'], ['falling', 'رهاشونده']] as [Mode, string][]).map(([mode, label]) =>
              <button key={mode} type="button" className={settings.mode === mode ? 'active' : ''}
                aria-pressed={settings.mode === mode} onClick={() => change('mode', mode)}>{label}</button>,
            )}
          </div>
        </div>

        <div className="control-group sliders">
          <span className="group-label">نیروها و جنس پارچه</span>
          <Slider label="شدت باد" value={settings.wind} min={0} max={15} step={0.5}
            onChange={(value) => change('wind', value)} />
          <Slider label="جهت باد" value={settings.windDirection} min={0} max={360} step={5} unit="°"
            onChange={(value) => change('windDirection', value)} />
          <Slider label="گرانش" value={settings.gravity} min={0} max={20} step={0.2}
            onChange={(value) => change('gravity', value)} />
          <Slider label="سفتی پارچه" value={settings.stiffness} min={10} max={60} step={1}
            onChange={(value) => change('stiffness', value)} />
          <p className="slider-note">تغییر سفتی، پارچه را از نو می‌سازد.</p>
        </div>

        <div className="actions">
          <button className="primary-button" type="button" onClick={() => change('playing', !settings.playing)}>
            <span aria-hidden="true">{settings.playing ? 'Ⅱ' : '▶'}</span>{settings.playing ? 'توقف' : 'ادامه'}
          </button>
          <button className="secondary-button" type="button" onClick={() => lab.current?.reset()}>
            <span aria-hidden="true">↻</span> بازنشانی
          </button>
        </div>
        <div className="panel-foot">فیزیک واقعی پارچه و برخورد سه‌بعدی</div>
      </aside>

      <section className="viewer" aria-label="نمای سه‌بعدی شبیه‌ساز پارچه">
        <div ref={host} className="canvas-host" />
        {!ready && <div className="loading">{error ? `خطا در بارگذاری: ${error}` : 'در حال آماده‌سازی فیزیک…'}</div>}
        <div className="viewer-top"><span className="scene-tag">{settings.mode === 'hanging' ? 'صحنه ۱ / آویزان' : 'صحنه ۲ / رهاشونده'}</span></div>
        <div className="viewer-bottom">
          <span>برای جابه‌جایی، کره {settings.mode === 'hanging' ? 'یا میله' : ''} را بکشید</span>
          <span className="viewer-hint">چرخش نما: کشیدن فضای خالی · بزرگ‌نمایی: اسکرول</span>
        </div>
      </section>
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
