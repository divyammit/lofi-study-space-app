import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { useStore } from './store'
import type { BillingInfo, Plan } from './types'
import DemoCheckout, { type DemoOrder } from '../components/DemoCheckout'

/** Prefilled question when something else opens the tutor (e.g. "Quiz me on this note"). */
export interface TutorPrefill { text: string; noteId?: string }

interface ProStore {
  plan: Plan
  setPlan: (p: Plan) => void
  billing: BillingInfo | null
  loadBilling: () => Promise<void>
  /** Runs Razorpay checkout for a plan. Resolves true once the server has verified the payment. */
  checkout: (planId: string) => Promise<boolean>
  checkingOut: boolean
  /** Opens the Pro panel; `reason` explains which locked feature sent the user there. */
  openPro: (reason?: string) => void
  proReason: string | null
  proSignal: number
  openTutor: (prefill?: TutorPrefill) => void
  takeTutorPrefill: () => TutorPrefill | null
  tutorSignal: number
  /** bumps when a new UPI payment arrives for the team to review */
  reviewSignal: number
}

const Ctx = createContext<ProStore | null>(null)
export const usePro = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePro outside ProProvider')
  return c
}

interface RazorpayResponse { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }
interface RazorpayInstance { open: () => void; on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void }
declare global { interface Window { Razorpay?: new (options: object) => RazorpayInstance } }

// Razorpay asks that checkout.js is always loaded from their CDN, never copied into the app
let scriptPromise: Promise<void> | null = null
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://checkout.razorpay.com/v1/checkout.js'
      s.async = true
      s.onload = () => (window.Razorpay ? resolve() : reject(new Error('no Razorpay')))
      s.onerror = () => { scriptPromise = null; reject(new Error('load failed')) }
      document.head.appendChild(s)
    })
  }
  return scriptPromise
}

export function ProProvider({ initial, children }: { initial: Plan; children: ReactNode }) {
  const { toast, socket } = useStore()
  const [plan, setPlan] = useState<Plan>(initial)
  const [billing, setBilling] = useState<BillingInfo | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [proReason, setProReason] = useState<string | null>(null)
  const [demo, setDemo] = useState<{ order: DemoOrder; resolve: (ok: boolean) => void } | null>(null)
  const [proSignal, setProSignal] = useState(0)
  const [tutorSignal, setTutorSignal] = useState(0)
  const prefill = useRef<TutorPrefill | null>(null)

  const loadBilling = useCallback(async () => {
    try {
      const b = await api<BillingInfo>('/api/billing')
      setBilling(b)
      setPlan(b.plan)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load plans')
    }
  }, [toast])

  const checkout = useCallback(async (planId: string) => {
    setCheckingOut(true)
    try {
      const order = await api<{ provider: 'razorpay' | 'demo' | 'upi'; keyId: string | null; orderId: string; amount: number; currency: string; planName: string; prefill: { name: string; email: string } }>(
        '/api/billing/orders', { body: { planId } },
      )
      if (order.provider === 'upi') {
        // UPI QR payments have their own checkout page
        window.location.assign(`/checkout/${encodeURIComponent(order.orderId)}`)
        return await new Promise<boolean>(() => {})
      }
      if (order.provider === 'demo') {
        // built-in demo gateway: same order -> pay -> verify flow, simulated checkout window
        return await new Promise<boolean>(resolve => setDemo({ order: { ...order, planId }, resolve }))
      }
      try { await loadCheckout() } catch {
        toast("Couldn't load Razorpay's payment window. Check your internet connection or turn off any ad-blocker for this site.")
        void api('/api/billing/failed', { body: { orderId: order.orderId } }).catch(() => {})
        return false
      }
      return await new Promise<boolean>(resolve => {
        let settled = false
        const rzp = new window.Razorpay!({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'Lo-Fi Study Space',
          description: order.planName,
          prefill: { name: order.prefill.name, email: order.prefill.email },
          notes: { plan: planId },
          theme: { color: '#f2a65a' },
          handler: async (resp: RazorpayResponse) => {
            settled = true
            try {
              // the server checks Razorpay's signature before giving Pro: the browser alone can't fake a payment
              const r = await api<{ ok: boolean; plan: Plan }>('/api/billing/verify', { body: resp })
              setPlan(r.plan)
              toast(`Payment successful. You're Pro until ${new Date(r.plan.proUntil!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`)
              void loadBilling()
              resolve(true)
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not verify the payment')
              void loadBilling()
              resolve(false)
            }
          },
          modal: {
            ondismiss: () => {
              if (settled) return
              settled = true
              void api('/api/billing/failed', { body: { orderId: order.orderId } }).catch(() => {})
              toast('Payment cancelled. You were not charged.')
              resolve(false)
            },
          },
        })
        // a failed attempt keeps the window open so the student can try another method
        rzp.on('payment.failed', r => toast(`Payment failed: ${r.error?.description ?? 'please try again'}`))
        rzp.open()
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the payment')
      return false
    } finally {
      setCheckingOut(false)
    }
  }, [toast, loadBilling])

  // live updates: the team approved/rejected my payment, or (for the team) a new payment needs checking
  const reviewSignalRef = useRef<() => void>(() => {})
  const [reviewSignal, setReviewSignal] = useState(0)
  reviewSignalRef.current = () => setReviewSignal(n => n + 1)
  useEffect(() => {
    if (!socket) return
    const onUpdated = ({ status }: { status: string }) => {
      void loadBilling()
      if (status === 'paid') toast('Your payment was confirmed. Welcome to Lo-Fi Pro!')
      else if (status === 'failed') toast("We couldn't verify your payment. Open Pro for details.", { label: 'Open', run: () => { setProReason(null); setProSignal(n => n + 1) } })
    }
    const onReview = ({ name, amount }: { name: string; amount: number }) => {
      reviewSignalRef.current()
      toast(`${name} paid ${formatInr(amount)} by UPI. Check and approve it.`, { label: 'Review', run: () => { setProReason(null); setProSignal(n => n + 1) } })
    }
    socket.on('billing:updated', onUpdated)
    socket.on('billing:review', onReview)
    return () => { socket.off('billing:updated', onUpdated); socket.off('billing:review', onReview) }
  }, [socket, loadBilling, toast])

  /** Demo checkout hands its gateway response here, exactly like Razorpay's handler does. */
  const verifyDemo = useCallback(async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
    const r = await api<{ ok: boolean; plan: Plan }>('/api/billing/verify', { body: resp })
    setPlan(r.plan)
    void loadBilling()
    return r.plan
  }, [loadBilling])

  const openPro = useCallback((reason?: string) => {
    setProReason(reason ?? null)
    setProSignal(n => n + 1)
  }, [])
  const openTutor = useCallback((p?: TutorPrefill) => {
    prefill.current = p ?? null
    setTutorSignal(n => n + 1)
  }, [])
  const takeTutorPrefill = useCallback(() => {
    const p = prefill.current
    prefill.current = null
    return p
  }, [])

  return (
    <Ctx.Provider value={{ plan, setPlan, billing, loadBilling, checkout, checkingOut, openPro, proReason, proSignal, openTutor, takeTutorPrefill, tutorSignal, reviewSignal }}>
      {children}
      {demo && (
        <DemoCheckout
          order={demo.order}
          verify={verifyDemo}
          onClose={(paid, plan) => {
            const d = demo
            setDemo(null)
            if (paid && plan?.proUntil) toast(`Payment successful. You're Pro until ${formatDate(plan.proUntil)}.`)
            else if (!paid) toast('Payment cancelled. You were not charged.')
            void loadBilling()
            d.resolve(paid)
          }}
        />
      )}
    </Ctx.Provider>
  )
}

export const formatInr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
export const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
