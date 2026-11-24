import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { api, ApiError } from '../lib/api'
import type { Account } from '../lib/types'
import PixelIcon from './PixelIcon'

/**
 * Full-page checkout for UPI QR payments (/checkout/<orderId>).
 * 1. Pay: scan the QR (amount + order reference pre-filled) or tap "Pay with UPI app" on a phone
 * 2. Confirm: enter the 12-digit UPI reference number (UTR) from the payment app
 * 3. Activate: the team checks the payment, then Pro switches on (this page updates by itself)
 */

interface Order {
  orderId: string
  plan: string
  planName: string
  planDays: number | null
  amount: number
  status: 'created' | 'pending' | 'paid' | 'failed'
  provider: string
  reference: string | null
  utr: string | null
  reviewNote: string | null
  createdAt: number
  claimedAt: number | null
  paidAt: number | null
  proUntilAfter: number | null
  upi: { payee: string; vpa: string; link: string; note: string } | null
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const SANS = { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

const PERKS = [
  'AI study tutor: 150 questions a day',
  'Ask about photos, your whiteboard and notes',
  'All four room themes unlocked',
  'Everything else stays free, as always',
]

export default function CheckoutPage({ orderId, account }: { orderId: string; account: Account }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [loadError, setLoadError] = useState('')
  const [qr, setQr] = useState('')
  const [utr, setUtr] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const phone = useMemo(isPhone, [])
  const backHome = () => window.location.assign('/')

  const load = useCallback(async () => {
    try {
      setOrder(await api<Order>(`/api/billing/orders/${encodeURIComponent(orderId)}`))
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 404 ? "This payment link doesn't exist or belongs to another account." : "Couldn't load this payment. Check your connection and refresh.")
    }
  }, [orderId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { document.title = 'Checkout · Lo-Fi Study Space' }, [])

  // while the team is checking, look for the result every few seconds
  useEffect(() => {
    if (order?.status !== 'pending') return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 4000)
    return () => clearInterval(t)
  }, [order?.status, load])

  useEffect(() => {
    if (!order?.upi) return
    QRCode.toDataURL(order.upi.link, { errorCorrectionLevel: 'H', margin: 1, width: 560, color: { dark: '#1d1b26', light: '#ffffff' } })
      .then(setQr, () => setQr(''))
  }, [order?.upi])

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1600) }, () => {})
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    const digits = utr.replace(/\D/g, '')
    if (digits.length !== 12) { setError('The UPI reference number has 12 digits. You can find it in your payment app under the transaction details.'); return }
    setBusy(true)
    setError('')
    try {
      await api('/api/billing/upi/claim', { body: { orderId, utr: digits } })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    await api('/api/billing/failed', { body: { orderId } }).catch(() => {})
    backHome()
  }

  async function startAgain() {
    if (!order) return
    setBusy(true)
    try {
      const o = await api<{ orderId: string }>('/api/billing/orders', { body: { planId: order.plan } })
      window.location.assign(`/checkout/${o.orderId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a new payment.')
      setBusy(false)
    }
  }

  const step = !order ? 0 : order.status === 'created' ? 1 : order.status === 'pending' ? 2 : order.status === 'paid' ? 3 : 1

  return (
    <div className="checkout-page h-full w-full overflow-y-auto bg-[#15121f] text-[#1d1b26]" style={SANS}>
      {/* top bar */}
      <header className="mx-auto flex max-w-[1040px] items-center justify-between gap-3 px-4 py-4 text-white sm:px-6">
        <button onClick={backHome} className="flex items-center gap-2.5 rounded-lg pr-2 text-left transition hover:opacity-80" aria-label="Back to Lo-Fi Study Space">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f2a65a] text-[#2e2940]"><PixelIcon name="crown" size={20} /></span>
          <span className="font-title text-[15px] tracking-wide sm:text-[17px]">Lo-Fi Study Space</span>
        </button>
        <span className="flex items-center gap-1.5 text-[13px] text-white/60">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          Secure checkout
        </span>
      </header>

      <main className="mx-auto max-w-[1040px] px-4 pb-10 sm:px-6">
        {loadError ? (
          <div className="mx-auto mt-10 max-w-md rounded-2xl bg-white p-6 text-center">
            <p className="text-[16px] font-semibold">Payment not found</p>
            <p className="mt-1 text-[14px] text-[#6b6880]">{loadError}</p>
            <button className="mt-4 rounded-lg bg-[#2e2940] px-5 py-2.5 text-[14px] font-semibold text-white" onClick={backHome}>Back to my room</button>
          </div>
        ) : !order ? (
          <div className="flex justify-center py-24"><Spinner light /></div>
        ) : (
          <div className="checkout-in grid overflow-hidden rounded-2xl bg-white shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            {/* ---------- order summary ---------- */}
            <aside className="relative overflow-hidden bg-[#2e2940] p-5 text-white sm:p-8">
              <div className="checkout-grid pointer-events-none absolute inset-0 opacity-[0.07]" aria-hidden="true" />
              <div className="relative">
                <p className="text-[13px] font-medium text-[#f2a65a]">You&rsquo;re upgrading to</p>
                <h1 className="mt-1 text-[26px] leading-tight font-bold tracking-tight">Lo-Fi Pro</h1>
                <p className="text-[14px] text-white/70">{order.planName.replace('Pro · ', '')} of Pro{order.planDays ? ` · ${order.planDays} days` : ''}</p>

                <div className="mt-4 flex items-end gap-2 md:mt-6">
                  <span className="text-[34px] leading-none font-bold tracking-tight md:text-[40px]">{inr(order.amount)}</span>
                  <span className="pb-1 text-[13px] text-white/60">one-time</span>
                </div>

                <ul className="mt-6 hidden flex-col gap-2.5 md:flex">
                  {PERKS.map(p => (
                    <li key={p} className="flex items-start gap-2.5 text-[14px] text-white/90">
                      <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-[#f2a65a]/20 text-[#f2a65a]">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>

                <dl className="mt-5 space-y-2 border-t border-white/10 pt-4 text-[13px] md:mt-7 md:pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-white/55">Order reference</dt>
                    <dd className="flex items-center gap-1.5 font-mono text-[13px] tracking-wide">
                      {order.reference}
                      {order.reference && <CopyButton dark label="Copy order reference" done={copied === 'ref'} onClick={() => copy(order.reference!, 'ref')} />}
                    </dd>
                  </div>
                  <div className="hidden items-center justify-between gap-3 md:flex">
                    <dt className="text-white/55">Account</dt>
                    <dd className="truncate">@{account.username}</dd>
                  </div>
                  <div className="hidden items-center justify-between gap-3 md:flex">
                    <dt className="text-white/55">Renewal</dt>
                    <dd>None. Buy again to extend.</dd>
                  </div>
                </dl>
              </div>
            </aside>

            {/* ---------- payment ---------- */}
            <section className="min-w-0 p-6 sm:p-8">
              <Stepper step={step} failed={order.status === 'failed'} />

              {order.status === 'created' && order.upi && (
                <div className="mt-6">
                  <h2 className="text-[20px] font-bold tracking-tight">Pay with any UPI app</h2>
                  <p className="mt-1 text-[14px] text-[#6b6880]">The amount and order reference are filled in for you.</p>

                  {phone && (
                    <a href={order.upi.link} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#2e2940] py-3.5 text-[15px] font-semibold text-white transition hover:bg-[#3d3754]">
                      Pay {inr(order.amount)} with UPI app
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
                    </a>
                  )}

                  <div className={`mt-5 flex flex-col items-center ${phone ? 'rounded-xl border border-[#e9e7f0] bg-[#faf9fc] py-4' : ''}`}>
                    {phone && <p className="mb-3 text-[13px] text-[#6b6880]">Or scan from another phone</p>}
                    <div className="qr-frame relative rounded-2xl bg-white p-3">
                      {qr ? <img src={qr} alt={`UPI QR code to pay ${inr(order.amount)} to ${order.upi.payee}`} className="block h-[220px] w-[220px] sm:h-[240px] sm:w-[240px]" /> : <div className="flex h-[240px] w-[240px] items-center justify-center"><Spinner /></div>}
                      {qr && (
                        <span className="absolute top-1/2 left-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border-4 border-white bg-[#f2a65a] text-[#2e2940]" aria-hidden="true">
                          <PixelIcon name="crown" size={20} />
                        </span>
                      )}
                      <span className="qr-scan pointer-events-none absolute inset-x-3 top-3 h-0.5 rounded-full bg-[#5b4bdb]/70" aria-hidden="true" />
                    </div>
                    <div className="mt-4 text-center">
                      <div className="text-[22px] font-bold tracking-tight">{inr(order.amount)}</div>
                      <div className="mt-0.5 text-[13px] text-[#6b6880]">to <span className="font-semibold text-[#1d1b26]">{order.upi.payee}</span></div>
                      <button className="mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[13px] text-[#4a4660] transition hover:bg-[#f0eef6]" onClick={() => copy(order.upi!.vpa, 'vpa')}>
                        {order.upi.vpa}
                        <span className="font-sans text-[12px] font-semibold text-[#5b4bdb]">{copied === 'vpa' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <p className="mt-3 text-[12px] text-[#8b88a0]">Works with Google Pay, PhonePe, Paytm, BHIM and any bank&rsquo;s UPI app</p>
                  </div>

                  <form onSubmit={confirm} className="mt-6 border-t border-[#ecebf2] pt-5" noValidate>
                    <label htmlFor="utr" className="text-[15px] font-semibold">Paid? Confirm your payment</label>
                    <p className="mt-0.5 text-[13px] text-[#6b6880]">Enter the 12-digit UPI reference number (UTR) from your payment app.</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        id="utr"
                        className="min-w-0 flex-1 rounded-lg border border-[#d6d3de] bg-white px-3.5 py-3 font-mono text-[16px] tracking-[0.12em] outline-none transition focus:border-[#5b4bdb] focus:ring-2 focus:ring-[#5b4bdb]/20"
                        inputMode="numeric" autoComplete="off" placeholder="1234 5678 9012" maxLength={14}
                        value={utr}
                        onChange={e => { setUtr(e.target.value.replace(/\D/g, '').slice(0, 12).replace(/(\d{4})(?=\d)/g, '$1 ')); setError('') }}
                      />
                      <button type="submit" disabled={busy || utr.replace(/\D/g, '').length !== 12}
                        className="rounded-lg bg-[#f2a65a] px-6 py-3 text-[15px] font-bold text-[#2a1c10] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45">
                        {busy ? 'Submitting…' : 'Confirm payment'}
                      </button>
                    </div>
                    {error && <p className="mt-2 rounded-md bg-[#fdecee] px-3 py-2 text-[13px] text-[#b4233a]" role="alert">{error}</p>}
                    <button type="button" className="mt-3 flex items-center gap-1 text-[13px] font-medium text-[#5b4bdb]" onClick={() => setShowHelp(v => !v)} aria-expanded={showHelp}>
                      Where do I find the UTR?
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition ${showHelp ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
                    </button>
                    {showHelp && (
                      <ol className="mt-2 list-decimal space-y-1 rounded-lg bg-[#f6f5f9] py-3 pr-3 pl-8 text-[13px] text-[#4a4660]">
                        <li>Open your UPI app and tap the payment you just made.</li>
                        <li>Look for <b>UPI transaction ID</b>, <b>UPI Ref No.</b> or <b>UTR</b>.</li>
                        <li>It&rsquo;s a 12-digit number, for example <span className="font-mono">4321 9876 5432</span>.</li>
                      </ol>
                    )}
                  </form>

                  <div className="mt-5 flex items-center justify-between text-[13px]">
                    <span className="text-[#8b88a0]">Pro switches on once the team confirms your payment.</span>
                    <button className="shrink-0 font-medium text-[#6b6880] underline-offset-2 hover:underline" onClick={() => void cancel()}>Cancel</button>
                  </div>
                </div>
              )}

              {order.status === 'pending' && (
                <div className="mt-8 flex flex-col items-center text-center">
                  <div className="relative flex h-20 w-20 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-[#f2a65a]/25" />
                    <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-[#fff4e8] text-[#c9701f]">
                      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    </span>
                  </div>
                  <h2 className="mt-4 text-[20px] font-bold tracking-tight">Verifying your payment</h2>
                  <p className="mt-1 max-w-sm text-[14px] text-[#6b6880]">
                    We&rsquo;ve received your details and the team is matching them with the payment. This page updates by itself, and you can close it: Pro switches on as soon as it&rsquo;s confirmed.
                  </p>
                  <dl className="mt-5 w-full max-w-sm divide-y divide-[#ecebf2] rounded-xl border border-[#ecebf2] text-left text-[14px]">
                    <Row k="Amount" v={inr(order.amount)} />
                    <Row k="UPI reference" v={order.utr ? order.utr.replace(/(\d{4})(?=\d)/g, '$1 ') : ''} mono />
                    <Row k="Order reference" v={order.reference ?? ''} mono />
                    {order.claimedAt && <Row k="Submitted" v={date(order.claimedAt)} />}
                  </dl>
                  <button className="mt-6 rounded-lg bg-[#2e2940] px-6 py-3 text-[15px] font-semibold text-white transition hover:bg-[#3d3754]" onClick={backHome}>Back to my room</button>
                </div>
              )}

              {order.status === 'paid' && (
                <div className="mt-8 flex flex-col items-center text-center">
                  <div className="checkout-pop relative flex h-20 w-20 items-center justify-center rounded-full bg-[#16a34a] text-white">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path className="checkout-tick" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                    {Array.from({ length: 8 }, (_, i) => <span key={i} className="checkout-spark" style={{ '--a': `${i * 45}deg` } as React.CSSProperties} aria-hidden="true" />)}
                  </div>
                  <h2 className="mt-5 text-[22px] font-bold tracking-tight">You&rsquo;re Pro!</h2>
                  <p className="mt-1 text-[14px] text-[#6b6880]">Payment confirmed. Enjoy the full study tutor and every room theme.</p>
                  <dl className="mt-5 w-full max-w-sm divide-y divide-[#ecebf2] rounded-xl border border-[#ecebf2] text-left text-[14px]">
                    <Row k="Amount paid" v={inr(order.amount)} />
                    <Row k="Plan" v={order.planName} />
                    {order.proUntilAfter && <Row k="Pro until" v={new Date(order.proUntilAfter).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} />}
                    <Row k="UPI reference" v={order.utr ? order.utr.replace(/(\d{4})(?=\d)/g, '$1 ') : ''} mono />
                    {order.paidAt && <Row k="Confirmed" v={date(order.paidAt)} />}
                  </dl>
                  <button className="mt-6 rounded-lg bg-[#f2a65a] px-7 py-3 text-[15px] font-bold text-[#2a1c10] transition hover:brightness-105" onClick={backHome} autoFocus>Start using Pro</button>
                </div>
              )}

              {order.status === 'failed' && (
                <div className="mt-8 flex flex-col items-center text-center">
                  <div className="checkout-pop flex h-20 w-20 items-center justify-center rounded-full bg-[#fdecee] text-[#dc2626]">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></svg>
                  </div>
                  <h2 className="mt-5 text-[20px] font-bold tracking-tight">{order.utr ? "We couldn't verify this payment" : 'This payment was cancelled'}</h2>
                  <p className="mt-1 max-w-sm text-[14px] text-[#6b6880]">
                    {order.utr ? (order.reviewNote ?? 'The team could not match it to a received payment.') : 'Nothing was charged for this order.'}
                  </p>
                  {order.utr && <p className="mt-2 max-w-sm text-[13px] text-[#8b88a0]">If money left your account, keep your UPI reference ({order.utr}) and contact the team.</p>}
                  {error && <p className="mt-3 rounded-md bg-[#fdecee] px-3 py-2 text-[13px] text-[#b4233a]">{error}</p>}
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <button className="rounded-lg bg-[#2e2940] px-6 py-3 text-[15px] font-semibold text-white transition hover:bg-[#3d3754] disabled:opacity-50" disabled={busy} onClick={() => void startAgain()}>Start a new payment</button>
                    <button className="rounded-lg px-5 py-3 text-[15px] font-medium text-[#6b6880] hover:bg-[#f0eef6]" onClick={backHome}>Back to my room</button>
                  </div>
                </div>
              )}

              {order.status === 'created' && !order.upi && (
                <p className="mt-8 rounded-lg bg-[#fdecee] p-4 text-[14px] text-[#b4233a]">UPI payments are switched off on this site right now. Go back and try again later.</p>
              )}
            </section>
          </div>
        )}
        <p className="mt-5 text-center text-[12px] text-white/40">Payments go directly to the Lo-Fi Study Space team&rsquo;s UPI account. This site never sees your bank or UPI PIN.</p>
      </main>
    </div>
  )
}

function Stepper({ step, failed }: { step: number; failed: boolean }) {
  const steps = ['Pay', 'Confirm', 'Pro activated']
  return (
    <ol className="flex items-center gap-2" aria-label="Checkout progress">
      {steps.map((label, i) => {
        const n = i + 1
        const done = step > n || (step === 3 && n === 3)
        const current = step === n && !(step === 3)
        return (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={current ? 'step' : undefined}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition ${
              done ? 'bg-[#16a34a] text-white' : current ? (failed ? 'bg-[#dc2626] text-white' : 'bg-[#2e2940] text-white') : 'bg-[#ecebf2] text-[#8b88a0]'}`}>
              {done ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : n}
            </span>
            <span className={`text-[13px] whitespace-nowrap ${current || done ? 'font-semibold text-[#1d1b26]' : 'text-[#8b88a0]'}`}>{label}</span>
            {n < steps.length && <span className={`hidden h-0.5 flex-1 rounded-full sm:block ${step > n ? 'bg-[#16a34a]' : 'bg-[#ecebf2]'}`} />}
          </li>
        )
      })}
    </ol>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
      <dt className="shrink-0 text-[#6b6880]">{k}</dt>
      <dd className={`min-w-0 text-right font-medium break-all ${mono ? 'font-mono text-[13px]' : ''}`}>{v}</dd>
    </div>
  )
}

function CopyButton({ onClick, done, label, dark }: { onClick: () => void; done: boolean; label: string; dark?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={done ? 'Copied' : 'Copy'} className={`rounded p-1 transition ${dark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-[#6b6880] hover:bg-[#f0eef6]'}`}>
      {done
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>}
    </button>
  )
}

function Spinner({ light }: { light?: boolean }) {
  return <div className={`h-10 w-10 animate-spin rounded-full border-4 ${light ? 'border-white/15 border-t-[#f2a65a]' : 'border-[#e4e2ec] border-t-[#5b4bdb]'}`} role="status" aria-label="Loading" />
}
