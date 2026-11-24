import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../lib/store'
import type { ReviewItem } from '../../lib/types'
import { usePro, formatDate, formatInr } from '../../lib/pro'
import { Panel, SectionTitle } from '../ui'
import PixelIcon from '../PixelIcon'

export default function ProPanel({ onClose }: { onClose: () => void }) {
  const { plan, billing, loadBilling, checkout, checkingOut, proReason } = usePro()
  useEffect(() => { void loadBilling() }, [loadBilling])

  const free = billing?.limits.freeDaily ?? 10
  const pro = billing?.limits.proDaily ?? 150
  const monthly = billing?.plans.find(p => p.id === 'pro_month')
  const yearly = billing?.plans.find(p => p.id === 'pro_year')
  const saving = monthly && yearly ? Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100) : 0

  const rows: [string, string | boolean, string | boolean][] = [
    ['AI tutor questions per day', String(free), String(pro)],
    ['Ask about a photo of a question', false, true],
    ['Ask about your whiteboard', false, true],
    ['Explain or quiz you on your notes', false, true],
    ['Room themes', '1', 'All 4'],
    ['Timer, tasks, notes, whiteboard, sounds', true, true],
    ['Friends, chats, calls, Study Street', true, true],
  ]
  const cell = (v: string | boolean) =>
    typeof v === 'string' ? v : v ? <span className="text-moss" aria-label="Included">✓</span> : <span className="text-muted" aria-label="Not included">—</span>

  return (
    <Panel title="Lo-Fi Pro" onClose={onClose}>
      <div className={`px-card flex items-center gap-3 p-3 ${plan.pro ? 'outline-2 outline-amber' : ''}`}>
        <PixelIcon name="crown" size={34} className={plan.pro ? 'text-amber' : 'text-muted'} />
        <div className="min-w-0 flex-1">
          {plan.pro && plan.proUntil ? (
            <>
              <div className="font-title text-[18px] text-amber">You&rsquo;re Pro</div>
              <div className="text-muted">Active until {formatDate(plan.proUntil)}. Buying again adds time on top.</div>
            </>
          ) : (
            <>
              <div className="font-title text-[18px]">Free plan</div>
              <div className="text-muted">{proReason ?? 'Upgrade for the full AI study tutor and every room theme.'}</div>
            </>
          )}
        </div>
      </div>

      {billing?.isAdmin && <PaymentReview />}

      <SectionTitle>Free vs Pro</SectionTitle>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="text-[17px] text-muted">
            <th className="py-1 font-normal">Feature</th>
            <th className="w-16 py-1 text-center font-normal">Free</th>
            <th className="w-16 py-1 text-center font-normal text-amber">Pro</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f, p]) => (
            <tr key={label} className="border-t-2 border-line">
              <td className="py-1 pr-2">{label}</td>
              <td className="py-1 text-center">{cell(f)}</td>
              <td className="py-1 text-center">{cell(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <SectionTitle>{plan.pro ? 'Extend Pro' : 'Choose a plan'}</SectionTitle>
      {!billing ? <p className="text-muted">Loading plans…</p> : !billing.configured ? (
        <p className="border-2 border-line p-3 text-muted">Payments aren&rsquo;t switched on for this site yet. The site owner needs to add Razorpay keys (see DEPLOY.md, &ldquo;Payments&rdquo;).</p>
      ) : (
        <>
          {billing.mode === 'razorpay_test' && (
            <div className="mb-3 border-2 border-dashed border-amber p-2 text-[17px]">
              <span className="text-amber">Test mode:</span> no real money moves. Pay with card <span className="font-mono">4100 2800 0000 1007</span>, any future expiry, any CVV and OTP <span className="font-mono">1234</span>, or UPI ID <span className="font-mono">success@razorpay</span>.
            </div>
          )}
          {billing.mode === 'upi' && (
            <div className="mb-3 border-2 border-dashed border-amber p-2 text-[17px]">
              <span className="text-amber">UPI payment:</span> scan a QR with any UPI app on the next page. Pro switches on once the team confirms your payment, usually within a few minutes.
            </div>
          )}
          {billing.history.filter(h => h.status === 'pending').map(h => (
            <a key={h.id} href={`/checkout/${h.orderId}`} className="mb-3 flex items-center gap-3 border-2 border-amber p-2 text-[17px] hover:bg-card-hi">
              <span className="blink text-amber">●</span>
              <span className="flex-1">Your {formatInr(h.amount)} payment is being verified.</span>
              <span className="text-amber underline">View</span>
            </a>
          ))}
          {billing.mode === 'demo' && (
            <div className="mb-3 border-2 border-dashed border-amber p-2 text-[17px]">
              <span className="text-amber">Demo mode:</span> checkout is simulated and no real money moves. The checkout window shows test cards and UPI IDs to use.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {[monthly, yearly].filter(Boolean).map(p => (
              <div key={p!.id} className={`px-card flex flex-col gap-2 p-3 ${p!.id === 'pro_year' ? 'outline-2 outline-amber' : ''}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-title text-[17px]">{p!.id === 'pro_year' ? 'Yearly' : 'Monthly'}</span>
                  {p!.id === 'pro_year' && saving > 0 && <span className="bg-amber px-1.5 text-[15px] text-[#2a1c10]">save {saving}%</span>}
                </div>
                <div><span className="font-title text-[26px]">{formatInr(p!.amount)}</span> <span className="text-muted">/ {p!.days} days</span></div>
                <button className="px-solid px-primary !py-2" disabled={checkingOut} onClick={() => void checkout(p!.id)}>
                  {checkingOut ? 'Opening…' : `Pay ${formatInr(p!.amount)}`}
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[16px] text-muted">{billing.mode === 'upi' ? 'Pay by UPI from any app. Payments go straight to the team, and this app never sees your UPI PIN. One-time payment, no auto-renewal.' : billing.mode === 'demo' ? 'Demo checkout: payments are simulated end to end (order, signature check, receipt). One-time payment, no auto-renewal.' : 'Payments are handled securely by Razorpay (cards, UPI, net banking). This app never sees your card or UPI details. One-time payment, no auto-renewal.'}</p>
        </>
      )}

      {billing && billing.history.length > 0 && (
        <>
          <SectionTitle>Payment history</SectionTitle>
          <ul className="flex flex-col gap-1">
            {billing.history.map(h => (
              <li key={h.id} className="px-card flex flex-wrap items-center gap-x-3 px-3 py-2 text-[17px]">
                <span>{formatDate(h.createdAt)}</span>
                <span>{h.plan === 'pro_year' ? 'Pro · 1 year' : 'Pro · 1 month'}</span>
                <span>{formatInr(h.amount)}</span>
                <span className={`ml-auto ${h.status === 'paid' ? 'text-moss' : h.status === 'pending' ? 'text-amber' : 'text-muted'}`}>
                  {h.status === 'paid' ? 'Paid' : h.status === 'pending' ? 'Verifying' : h.utr ? 'Not verified' : 'Not completed'}
                </span>
                {h.provider === 'upi' && h.utr && <span className="w-full truncate text-[14px] text-muted">UPI ref {h.utr} · {h.reference}</span>}
                {h.provider === 'upi' && h.status === 'failed' && h.reviewNote && <span className="w-full text-[14px] text-rose">{h.reviewNote}</span>}
                {h.provider !== 'upi' && h.paymentId && <span className="w-full truncate text-[14px] text-muted">{h.method === 'upi' ? 'UPI' : h.method === 'card' ? 'Card' : 'Payment'} · {h.paymentId}{h.provider === 'demo' ? ' · demo' : ''}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

/** Team-only: UPI payments waiting to be matched against the bank/UPI app, with approve and reject. */
function PaymentReview() {
  const { toast } = useStore()
  const { reviewSignal } = usePro()
  const [data, setData] = useState<{ pending: ReviewItem[]; recent: ReviewItem[]; payee: { vpa: string; name: string } | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try { setData(await api('/api/billing/admin/pending')) } catch (e) { toast(e instanceof Error ? e.message : 'Could not load payments to review') }
  }, [toast])
  useEffect(() => { void load() }, [load, reviewSignal])
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 15000)
    return () => clearInterval(t)
  }, [load])

  const act = async (item: ReviewItem, action: 'approve' | 'reject') => {
    setBusy(item.id)
    try {
      await api(`/api/billing/admin/${item.id}/${action}`, { body: action === 'reject' ? { note } : {} })
      toast(action === 'approve' ? `Approved. ${item.name} is now Pro.` : `Rejected ${item.name}'s payment.`)
      setRejecting(null)
      setNote('')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong')
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionTitle>Payments to verify{data?.pending.length ? ` · ${data.pending.length}` : ''}</SectionTitle>
      <p className="mb-2 text-[16px] text-muted">
        Team only. Open {data?.payee ? <>the UPI app for <span className="text-ink">{data.payee.vpa}</span></> : 'the UPI app'} and check that a payment with the same amount and UPI reference (UTR) arrived before approving.
      </p>
      {!data ? <p className="text-muted">Loading…</p> : data.pending.length === 0 ? (
        <p className="px-card p-3 text-muted">Nothing waiting. New payments show up here and as a notification.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.pending.map(item => (
            <li key={item.id} className="px-card p-3 outline-2 outline-amber">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-title text-[18px] text-amber">{formatInr(item.amount)}</span>
                <span>{item.name} <span className="text-muted">@{item.username}</span></span>
                <span className="ml-auto text-[15px] text-muted">{item.claimedAt ? formatDate(item.claimedAt) : ''}</span>
              </div>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[16px]">
                <dt className="text-muted">UPI ref (UTR)</dt><dd className="font-mono tracking-wide">{item.utr?.replace(/(\d{4})(?=\d)/g, '$1 ')}</dd>
                <dt className="text-muted">Note in payment</dt><dd className="font-mono">LoFi Pro {item.reference}</dd>
                <dt className="text-muted">Plan</dt><dd>{item.planName}</dd>
              </dl>
              {rejecting === item.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  <input className="px-input" value={note} maxLength={200} placeholder="Reason shown to the student (optional)" onChange={e => setNote(e.target.value)} aria-label="Reason for rejecting" />
                  <div className="flex gap-2">
                    <button className="px-solid !bg-rose !text-white" disabled={busy === item.id} onClick={() => void act(item, 'reject')}>Reject payment</button>
                    <button className="px-btn" onClick={() => { setRejecting(null); setNote('') }}>Back</button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <button className="px-solid px-primary" disabled={busy === item.id} onClick={() => void act(item, 'approve')}>Approve</button>
                  <button className="px-btn hover:!text-rose" onClick={() => setRejecting(item.id)}>Reject…</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && data.recent.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[16px] text-muted">Recently reviewed</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {data.recent.map(r => (
              <li key={r.id} className="flex flex-wrap gap-x-3 px-1 text-[16px]">
                <span className={r.status === 'paid' ? 'text-moss' : 'text-rose'}>{r.status === 'paid' ? 'Approved' : 'Rejected'}</span>
                <span>{formatInr(r.amount)} · {r.name}</span>
                <span className="text-muted">by {r.reviewedBy ?? 'team'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
