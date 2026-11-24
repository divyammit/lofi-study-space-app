import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { Plan } from '../lib/types'
import PixelIcon from './PixelIcon'

/**
 * Checkout window for the built-in demo gateway (used when the site has no Razorpay keys).
 * It looks and flows like a real checkout: card or UPI, bank OTP, processing, receipt.
 * Only test card numbers and test UPI ids are accepted, card details never leave this window,
 * and the server signs and verifies the payment exactly as it does for Razorpay.
 */

export interface DemoOrder {
  orderId: string
  planId: string
  amount: number
  currency: string
  planName: string
  prefill: { name: string; email: string }
}

type GatewayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
type Step = 'method' | 'otp' | 'upi_wait' | 'processing' | 'success' | 'failed'

// test cards: anything else is refused, so nobody types a real card into a demo
const TEST_CARDS: Record<string, { brand: string; outcome: 'success' | 'failure' }> = {
  '4111111111111111': { brand: 'VISA', outcome: 'success' },
  '5555555555554444': { brand: 'MASTERCARD', outcome: 'success' },
  '4000000000000002': { brand: 'VISA', outcome: 'failure' },
}
const TEST_UPI: Record<string, 'success' | 'failure'> = { 'success@demo': 'success', 'failure@demo': 'failure' }
const DEMO_OTP = '1234'

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const digits = (s: string) => s.replace(/\D/g, '')
const brandOf = (n: string) => (/^4/.test(n) ? 'VISA' : /^(5[1-5]|2[2-7])/.test(n) ? 'MASTERCARD' : /^6/.test(n) ? 'RUPAY' : '')
const SANS = { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }

export default function DemoCheckout({ order: initialOrder, verify, onClose }: {
  order: DemoOrder
  verify: (r: GatewayResponse) => Promise<Plan>
  onClose: (paid: boolean, plan?: Plan) => void
}) {
  const [order, setOrder] = useState(initialOrder)
  const [step, setStep] = useState<Step>('method')
  const [tab, setTab] = useState<'card' | 'upi'>('card')
  const [card, setCard] = useState({ number: '', expiry: '', cvv: '', name: initialOrder.prefill.name })
  const [vpa, setVpa] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [failure, setFailure] = useState('')
  const [receipt, setReceipt] = useState<{ paymentId: string; method: 'card' | 'upi'; detail: string; at: number; plan: Plan } | null>(null)
  const [resendIn, setResendIn] = useState(30)
  const [upiLeft, setUpiLeft] = useState(300)
  const outcome = useRef<'success' | 'failure'>('success')
  const dialog = useRef<HTMLDivElement>(null)
  const busy = step === 'processing' || step === 'upi_wait'

  // focus the window, and let Escape close it unless a payment is in flight
  useEffect(() => { dialog.current?.focus() }, [step])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  useEffect(() => {
    if (step !== 'otp') return
    setResendIn(30)
    const t = setInterval(() => setResendIn(s => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [step])

  function close() {
    if (busy) return
    if (step === 'success' && receipt) { onClose(true, receipt.plan); return }
    if (step !== 'failed') void api('/api/billing/failed', { body: { orderId: order.orderId } }).catch(() => {})
    onClose(false)
  }

  async function charge(method: 'card' | 'upi', detail: string) {
    setStep('processing')
    try {
      const resp = await api<GatewayResponse>('/api/billing/demo/pay', { body: { orderId: order.orderId, method, outcome: outcome.current } })
      const plan = await verify(resp)
      setReceipt({ paymentId: resp.razorpay_payment_id, method, detail, at: Date.now(), plan })
      setStep('success')
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'Something went wrong. You were not charged.')
      setStep('failed')
    }
  }

  function payByCard(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const n = digits(card.number)
    const test = TEST_CARDS[n]
    if (n.length < 12) return setError('Enter a valid card number.')
    if (!test) return setError('This is a demo checkout, so real cards are not accepted. Use a test card shown below.')
    const [mm, yy] = card.expiry.split('/').map(x => Number(x))
    const now = new Date()
    if (!mm || mm > 12 || yy === undefined || Number.isNaN(yy) || 2000 + yy < now.getFullYear() || (2000 + yy === now.getFullYear() && mm < now.getMonth() + 1)) return setError('Enter a valid expiry date (MM/YY).')
    if (!/^\d{3,4}$/.test(card.cvv)) return setError('Enter the 3-digit CVV.')
    if (!card.name.trim()) return setError('Enter the name on the card.')
    outcome.current = test.outcome
    setOtp('')
    setStep('otp')
  }

  function submitOtp(e: React.FormEvent) {
    e.preventDefault()
    if (otp !== DEMO_OTP) { setError('Incorrect OTP. Please try again.'); return }
    setError('')
    const n = digits(card.number)
    void charge('card', `${TEST_CARDS[n].brand} •••• ${n.slice(-4)}`)
  }

  function payByUpi(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const id = vpa.trim().toLowerCase()
    if (!/^[a-z0-9._-]{2,}@[a-z]{2,}$/.test(id)) return setError('Enter a valid UPI ID, like name@bank.')
    const result = TEST_UPI[id]
    if (!result) return setError('This is a demo checkout. Use a test UPI ID shown below.')
    outcome.current = result
    setStep('upi_wait')
    setUpiLeft(300)
  }

  // UPI: count down while "waiting for approval", then the demo app approves (or declines)
  useEffect(() => {
    if (step !== 'upi_wait') return
    const tick = setInterval(() => setUpiLeft(s => Math.max(0, s - 1)), 1000)
    const approve = setTimeout(() => { void charge('upi', vpa.trim().toLowerCase()) }, 3800)
    return () => { clearInterval(tick); clearTimeout(approve) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  async function retry() {
    // the failed order is closed, so start a fresh one for the same plan
    setStep('processing')
    try {
      const o = await api<DemoOrder & { provider: string }>('/api/billing/orders', { body: { planId: order.planId } })
      setOrder({ ...o, planId: order.planId })
      setError('')
      setFailure('')
      setStep('method')
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not restart the payment.')
      setStep('failed')
    }
  }

  const n = digits(card.number)
  const brand = brandOf(n)
  const field = 'w-full rounded-md border border-[#d6d3de] bg-white px-3 py-2.5 text-[15px] text-[#1d1b26] outline-none transition focus:border-[#5b4bdb] focus:ring-2 focus:ring-[#5b4bdb]/20'
  const label = 'mb-1 block text-[12px] font-medium tracking-wide text-[#6b6880] uppercase'
  const primary = 'w-full rounded-md bg-[#2e2940] py-3 text-[15px] font-semibold text-white transition hover:bg-[#3d3754] disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Checkout"
        className="demo-checkout flex max-h-[100dvh] w-full flex-col overflow-hidden bg-[#f6f5f9] text-[#1d1b26] shadow-2xl outline-none sm:max-h-[92vh] sm:max-w-[420px] sm:rounded-xl"
        style={SANS}
      >
        {/* header: who you're paying and how much */}
        <div className="relative bg-[#2e2940] px-5 pt-4 pb-5 text-white">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f2a65a] text-[#2e2940]"><PixelIcon name="crown" size={22} /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold">Lo-Fi Study Space</div>
              <div className="truncate text-[13px] text-white/70">{order.planName}</div>
            </div>
            {!busy && (
              <button onClick={close} className="rounded-md p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white" aria-label="Close checkout">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <div className="text-[12px] text-white/60">Amount payable</div>
              <div className="text-[28px] leading-tight font-bold tracking-tight">{inr(order.amount)}</div>
            </div>
            <span className="rounded-full border border-[#f2a65a]/60 bg-[#f2a65a]/15 px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-[#f2a65a]">DEMO MODE</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {step === 'method' && (
            <div className="p-5">
              <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-[#e9e7f0] p-1" role="tablist">
                {(['card', 'upi'] as const).map(t => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setError('') }}
                    className={`rounded-md py-2 text-[14px] font-medium transition ${tab === t ? 'bg-white text-[#1d1b26] shadow-sm' : 'text-[#6b6880] hover:text-[#1d1b26]'}`}>
                    {t === 'card' ? 'Card' : 'UPI'}
                  </button>
                ))}
              </div>

              {tab === 'card' ? (
                <form onSubmit={payByCard} className="flex flex-col gap-3" noValidate>
                  <div>
                    <label className={label} htmlFor="dc-number">Card number</label>
                    <div className="relative">
                      <input id="dc-number" className={`${field} pr-24 tracking-wider`} inputMode="numeric" autoComplete="off" placeholder="1234 5678 9012 3456"
                        value={card.number} maxLength={19}
                        onChange={e => setCard(c => ({ ...c, number: digits(e.target.value).slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ') }))} />
                      {brand && <span className="absolute top-1/2 right-3 -translate-y-1/2 rounded bg-[#1d1b26] px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white">{brand}</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={label} htmlFor="dc-exp">Expiry</label>
                      <input id="dc-exp" className={field} inputMode="numeric" autoComplete="off" placeholder="MM/YY" maxLength={5} value={card.expiry}
                        onChange={e => { const d = digits(e.target.value).slice(0, 4); setCard(c => ({ ...c, expiry: d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d })) }} />
                    </div>
                    <div>
                      <label className={label} htmlFor="dc-cvv">CVV</label>
                      <input id="dc-cvv" className={field} inputMode="numeric" autoComplete="off" type="password" placeholder="•••" maxLength={4} value={card.cvv}
                        onChange={e => setCard(c => ({ ...c, cvv: digits(e.target.value).slice(0, 4) }))} />
                    </div>
                  </div>
                  <div>
                    <label className={label} htmlFor="dc-name">Name on card</label>
                    <input id="dc-name" className={field} autoComplete="off" value={card.name} maxLength={40} onChange={e => setCard(c => ({ ...c, name: e.target.value }))} />
                  </div>
                  {error && <p className="rounded-md bg-[#fdecee] px-3 py-2 text-[13px] text-[#b4233a]" role="alert">{error}</p>}
                  <button className={`${primary} mt-1`} type="submit">Pay {inr(order.amount)}</button>
                  <TestHint>
                    Test cards: <Code>4111 1111 1111 1111</Code> (success), <Code>4000 0000 0000 0002</Code> (declined). Any future expiry, any CVV.{' '}
                    <button type="button" className="font-semibold text-[#5b4bdb] underline" onClick={() => { setCard(c => ({ ...c, number: '4111 1111 1111 1111', expiry: `12/${String((new Date().getFullYear() + 3) % 100).padStart(2, '0')}`, cvv: '123' })); setError('') }}>Fill test card</button>
                  </TestHint>
                </form>
              ) : (
                <form onSubmit={payByUpi} className="flex flex-col gap-3" noValidate>
                  <div>
                    <label className={label} htmlFor="dc-vpa">UPI ID</label>
                    <input id="dc-vpa" className={field} autoComplete="off" autoCapitalize="none" placeholder="yourname@bank" value={vpa} onChange={e => setVpa(e.target.value)} />
                  </div>
                  {error && <p className="rounded-md bg-[#fdecee] px-3 py-2 text-[13px] text-[#b4233a]" role="alert">{error}</p>}
                  <button className={`${primary} mt-1`} type="submit">Verify and pay {inr(order.amount)}</button>
                  <TestHint>
                    Test UPI IDs: <Code>success@demo</Code> (approves), <Code>failure@demo</Code> (declines).{' '}
                    <button type="button" className="font-semibold text-[#5b4bdb] underline" onClick={() => { setVpa('success@demo'); setError('') }}>Fill test UPI</button>
                  </TestHint>
                </form>
              )}
            </div>
          )}

          {step === 'otp' && (
            <form onSubmit={submitOtp} className="p-5" noValidate>
              <div className="mb-3 flex items-center gap-2 text-[13px] text-[#6b6880]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                Secure card verification
              </div>
              <h3 className="text-[18px] font-semibold">Enter OTP</h3>
              <p className="mt-1 text-[14px] text-[#6b6880]">
                Confirm the payment of <span className="font-semibold text-[#1d1b26]">{inr(order.amount)}</span> on your {TEST_CARDS[digits(card.number)]?.brand ?? 'card'} ending {digits(card.number).slice(-4)}.
              </p>
              <input
                className={`${field} mt-4 text-center text-[22px] tracking-[0.6em]`}
                inputMode="numeric" autoComplete="one-time-code" maxLength={4} autoFocus aria-label="One-time password"
                value={otp} onChange={e => { setOtp(digits(e.target.value).slice(0, 4)); setError('') }}
              />
              {error && <p className="mt-2 rounded-md bg-[#fdecee] px-3 py-2 text-[13px] text-[#b4233a]" role="alert">{error}</p>}
              <button className={`${primary} mt-4`} type="submit" disabled={otp.length < 4}>Submit</button>
              <div className="mt-3 flex items-center justify-between text-[13px]">
                <button type="button" className="text-[#6b6880] underline" onClick={() => { setStep('method'); setError('') }}>Change card</button>
                <span className="text-[#6b6880]">{resendIn > 0 ? `Resend OTP in 0:${String(resendIn).padStart(2, '0')}` : <button type="button" className="font-semibold text-[#5b4bdb]" onClick={() => setResendIn(30)}>Resend OTP</button>}</span>
              </div>
              <TestHint>Demo OTP: <Code>{DEMO_OTP}</Code></TestHint>
            </form>
          )}

          {step === 'upi_wait' && (
            <div className="flex flex-col items-center p-6 text-center">
              <Spinner />
              <h3 className="mt-4 text-[17px] font-semibold">Approve the payment in your UPI app</h3>
              <p className="mt-1 text-[14px] text-[#6b6880]">A collect request for {inr(order.amount)} was sent to <span className="font-semibold text-[#1d1b26]">{vpa.trim().toLowerCase()}</span>.</p>
              <p className="mt-3 text-[13px] text-[#6b6880]">Request expires in {Math.floor(upiLeft / 60)}:{String(upiLeft % 60).padStart(2, '0')}</p>
              <p className="mt-4 text-[12px] text-[#8b88a0]">Demo mode: the test UPI app responds automatically.</p>
            </div>
          )}

          {step === 'processing' && (
            <div className="flex flex-col items-center p-8 text-center">
              <Spinner />
              <h3 className="mt-4 text-[17px] font-semibold">Processing your payment</h3>
              <p className="mt-1 text-[14px] text-[#6b6880]">Please don&rsquo;t close this window or press back.</p>
            </div>
          )}

          {step === 'success' && receipt && (
            <div className="p-5">
              <div className="flex flex-col items-center text-center">
                <div className="demo-pop flex h-16 w-16 items-center justify-center rounded-full bg-[#16a34a] text-white">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path className="demo-tick" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </div>
                <h3 className="mt-3 text-[19px] font-semibold">Payment successful</h3>
                <p className="mt-1 text-[14px] text-[#6b6880]">You&rsquo;re now on Lo-Fi Pro. A receipt is saved in your payment history.</p>
              </div>
              <dl className="mt-5 divide-y divide-[#e4e2ec] rounded-lg border border-[#e4e2ec] bg-white text-[14px]">
                {[
                  ['Amount paid', inr(order.amount)],
                  ['Plan', order.planName],
                  ['Paid with', receipt.method === 'card' ? receipt.detail : `UPI · ${receipt.detail}`],
                  ['Payment ID', receipt.paymentId],
                  ['Date', new Date(receipt.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <dt className="shrink-0 text-[#6b6880]">{k}</dt>
                    <dd className="min-w-0 text-right font-medium break-all">{v}</dd>
                  </div>
                ))}
              </dl>
              <button className={`${primary} mt-5`} onClick={close} autoFocus>Done</button>
            </div>
          )}

          {step === 'failed' && (
            <div className="p-5">
              <div className="flex flex-col items-center text-center">
                <div className="demo-pop flex h-16 w-16 items-center justify-center rounded-full bg-[#dc2626] text-white">
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </div>
                <h3 className="mt-3 text-[19px] font-semibold">Payment failed</h3>
                <p className="mt-1 text-[14px] text-[#6b6880]">{failure || 'The payment could not be completed.'}</p>
                <p className="mt-1 text-[13px] text-[#8b88a0]">No money was deducted.</p>
              </div>
              <button className={`${primary} mt-5`} onClick={() => void retry()}>Try again</button>
              <button className="mt-2 w-full rounded-md py-2.5 text-[14px] font-medium text-[#6b6880] hover:bg-[#e9e7f0]" onClick={close}>Cancel</button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-center gap-1.5 border-t border-[#e4e2ec] bg-white px-4 py-2.5 text-[11px] text-[#8b88a0]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          Secured checkout · Demo mode, no real money is charged
        </div>
      </div>
    </div>
  )
}

function TestHint({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 rounded-md border border-dashed border-[#d6d3de] bg-white px-3 py-2 text-[12px] leading-relaxed text-[#6b6880]">{children}</div>
}
function Code({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-[#efedf5] px-1 font-mono text-[11.5px] text-[#1d1b26]">{children}</span>
}
function Spinner() {
  return <div className="h-12 w-12 animate-spin rounded-full border-4 border-[#e4e2ec] border-t-[#5b4bdb]" role="status" aria-label="Loading" />
}
