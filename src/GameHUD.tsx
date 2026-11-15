import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { ClothLab, FlightTelemetry, MovementDirection } from './ClothLab'
import Wings from './Wings'
import { CITY_SCALE } from './City'

const initialTelemetry: FlightTelemetry = { state: 'grounded', altitude: 0, speed: 0, x: 0, z: 0, heading: 0 }

function HoldAction({ label, shortcut, disabled, onHold }: {
  label: string; shortcut: string; disabled: boolean; onHold: (pressed: boolean) => void
}) {
  const [pressed, setPressed] = useState(false)
  useEffect(() => {
    if (disabled) { onHold(false); setPressed(false) }
  }, [disabled, onHold])
  const release = () => { onHold(false); setPressed(false) }
  return <button type="button" className={`power-button ${pressed ? 'engaged' : ''}`}
    disabled={disabled} aria-label={`${label}؛ نگه دارید`} aria-pressed={pressed}
    onPointerDown={event => {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      onHold(true); setPressed(true)
    }} onPointerUp={event => {
      release()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
    onKeyDown={event => {
      if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); onHold(true); setPressed(true) }
    }} onKeyUp={event => {
      if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); release() }
    }}>{label} <kbd>{shortcut}</kbd></button>
}

function Radar({ telemetry }: { telemetry: FlightTelemetry }) {
  return <div className="radar" aria-label="نقشه کوچک؛ موقعیت شخصیت">
    <div className="radar-heading"><span>ناحیهٔ ساحلی</span><span dir="ltr">N ↑</span></div>
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <rect x="5" y="5" width="190" height="190" rx="32" className="radar-land" />
      <rect x="17" y="17" width="166" height="166" rx="23" className="radar-road" />
      <path d="M58 17V183M117 69V157M148 17V69M161 115V183M17 69H183M17 115H183M58 157H161" className="radar-street" />
      <path d="M70 79H107V105H70Z" className="radar-park" />
      <rect x="87" y="31" width="40" height="19" className="radar-building" />
      <circle cx="107" cy="40" r="9" className="radar-building" />
      <path d="M130 80H170V98H130ZM125 125H149V149H125ZM28 36H46V56H28Z" className="radar-building" />
      <g transform={`translate(${Math.max(7, Math.min(193, 100 + telemetry.x / CITY_SCALE))}, ${Math.max(7, Math.min(193, 100 + telemetry.z / CITY_SCALE))})`}>
        <circle r="9" className="radar-pulse" />
        <path d="M0 7 -4 -4 0 -2 4 -4Z" transform={`rotate(${-telemetry.heading * 180 / Math.PI})`} className="radar-player" />
      </g>
    </svg>
    <div className="radar-coordinates" dir="ltr">{Math.round(telemetry.x).toString().padStart(3, '0')} : {Math.round(telemetry.z).toString().padStart(3, '0')} <span>SECTOR 01</span></div>
  </div>
}


export default function GameHUD({ lab, telemetrySink, ready, menu }: {
  lab: RefObject<ClothLab | null>
  telemetrySink: RefObject<(telemetry: FlightTelemetry) => void>
  ready: boolean
  menu: boolean
}) {
  const [telemetry, setTelemetry] = useState(initialTelemetry)
  const [flightPressed, setFlightPressed] = useState(false)
  const [runPressed, setRunPressed] = useState(false)
  useEffect(() => {
    telemetrySink.current = setTelemetry
    return () => { telemetrySink.current = () => {} }
  }, [telemetrySink])
  useEffect(() => {
    if (menu || telemetry.state === 'released' || telemetry.state === 'recovering') {
      setFlightPressed(false)
      setRunPressed(false)
    }
  }, [menu, telemetry.state])
  const releaseFlight = () => { lab.current?.setTouchFlight(false); setFlightPressed(false) }
  const releaseRun = () => { lab.current?.setTouchRunning(false); setRunPressed(false) }
  const releaseDirection = (event: ReactPointerEvent<HTMLButtonElement>, direction: MovementDirection) => {
    lab.current?.setTouchDirection(direction, false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const released = telemetry.state === 'released'
  const recovering = telemetry.state === 'recovering'
  const airborne = released ? telemetry.altitude > .5 : !recovering && telemetry.state !== 'grounded'
  const flightLabel = released ? 'بدن رها؛ کنترل را برگردانید' : recovering ? 'در حال بلندشدن' : telemetry.state === 'landing' ? 'در حال فرود' : airborne ? 'پرواز فعال' : 'آمادهٔ پرواز'

  return <>
    <div className={`game-hud ${airborne ? 'is-airborne' : ''}`}>
      <Radar telemetry={telemetry} />
      <div className="flight-control">
        <span className="flight-eyebrow">{flightLabel}</span>
        <button type="button" className={`flight-button ${!released && (flightPressed || telemetry.state === 'flying') ? 'engaged' : ''}`}
          disabled={!ready || menu || released || recovering} aria-label="برخاستن و صعود؛ نگه دارید" aria-pressed={!released && !recovering && (flightPressed || telemetry.state === 'flying')}
          onPointerDown={event => {
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
            lab.current?.setTouchFlight(true); setFlightPressed(true)
          }}
          onPointerUp={event => {
            releaseFlight()
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }} onPointerCancel={releaseFlight} onLostPointerCapture={releaseFlight}
          onKeyDown={event => {
            if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); lab.current?.setTouchFlight(true); setFlightPressed(true) }
          }} onKeyUp={event => {
            if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); releaseFlight() }
          }} onBlur={releaseFlight}>
          <Wings /><span>{airborne ? 'صعود؛ رهاکردن برای شناوری' : 'برخاستن و صعود'}</span><kbd>SPACE</kbd>
        </button>
        <div className="secondary-controls">
          <button type="button" className="release-button" disabled={!ready || menu || recovering}
            onClick={() => lab.current?.toggleRelease()}>
            {released ? 'بازگشت کنترل' : 'رهاکردن بدن'} <kbd>X</kbd>
          </button>
          <button type="button" className={`run-button ${runPressed ? 'engaged' : ''}`}
            disabled={!ready || menu || released || recovering} aria-label="سرعت بیشتر؛ نگه دارید" aria-pressed={runPressed}
            onPointerDown={event => {
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
              lab.current?.setTouchRunning(true); setRunPressed(true)
            }}
            onPointerUp={event => {
              releaseRun()
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            }} onPointerCancel={releaseRun} onLostPointerCapture={releaseRun}
            onKeyDown={event => {
              if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); lab.current?.setTouchRunning(true); setRunPressed(true) }
            }} onKeyUp={event => {
              if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); releaseRun() }
            }} onBlur={releaseRun}>شتاب ۱۰×</button>
          <HoldAction label="لیزر چشم" shortcut="F" disabled={!ready || menu || released || recovering}
            onHold={pressed => lab.current?.setTouchLaser(pressed)} />
          <HoldAction label="فرود" shortcut="C" disabled={!ready || menu || released || recovering || !airborne}
            onHold={pressed => lab.current?.setTouchDescending(pressed)} />
        </div>
        <div className="flight-hint">{released ? <><kbd>X</kbd> بازگشت کنترل</> : recovering ? 'پس از بلندشدن، حرکت و پرواز فعال می‌شوند' : airborne ? <><kbd>W</kbd> جهت موس <span>·</span> <kbd>SHIFT + W</kbd> شتاب ۱۰×</>
          : <><span dir="ltr">W A S D</span> حرکت <span>·</span> <kbd>F</kbd> لیزر چشم</>}</div>
      </div>
      <div className="flight-instruments" aria-label="وضعیت پرواز">
        <div className="instrument-heading"><span className="instrument-dot" /><span>{released ? 'بدن رها' : recovering ? 'در حال بلندشدن' : airborne ? 'سامانهٔ پرواز' : 'روی زمین'}</span><span dir="ltr">{released ? 'FREE' : recovering ? 'GET UP' : airborne ? 'AIR' : 'GND'}</span></div>
        <div className="instrument-values"><div><span>ارتفاع</span><strong dir="ltr">{telemetry.altitude.toFixed(1)} <small>M</small></strong></div>
          <div><span>سرعت</span><strong dir="ltr">{Math.round(telemetry.speed * 3.6)} <small>KM/H</small></strong></div></div>
        <div className="altitude-track"><i style={{ width: `${Math.min(100, telemetry.altitude / 300 * 100)}%` }} /></div>
      </div>
    </div>

    <div className="touch-movement" role="group" aria-label="کنترل جهت حرکت">
      {([['forward', '↑', 'حرکت به جلو'], ['left', '←', 'حرکت به چپ'], ['right', '→', 'حرکت به راست'], ['backward', '↓', 'حرکت به عقب']] as const)
        .map(([direction, symbol, label]) => <button key={direction} type="button" className={`move-${direction}`} aria-label={label} disabled={menu || !ready || released || recovering}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); lab.current?.setTouchDirection(direction, true) }}
          onPointerUp={event => releaseDirection(event, direction)} onPointerCancel={event => releaseDirection(event, direction)}
          onLostPointerCapture={() => lab.current?.setTouchDirection(direction, false)}>{symbol}</button>)}
    </div>

  </>
}
