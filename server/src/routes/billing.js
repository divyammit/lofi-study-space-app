import { Router } from 'express'
import express from 'express'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ms, pool, q } from '../db.js'
import { HttpError, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { LIMITS, PLANS, planOf } from '../plans.js'

/**
 * Razorpay payments (Standard Checkout):
 *   1. POST /orders   server creates a Razorpay order for the chosen plan and records it as 'created'
 *   2. the browser opens Razorpay's checkout with that order id; the student pays
 *   3. POST /verify   server checks Razorpay's signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
 *                     and only then marks the payment 'paid' and extends pro_until
 *   4. POST /webhook  (optional backup) Razorpay tells the server directly, in case the tab was closed
 *
 * Environment: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, optional RAZORPAY_WEBHOOK_SECRET.
 * Test-mode keys start with rzp_test_ and move no real money.
 * Without Razorpay keys, the built-in demo gateway below is used instead (DEMO_PAYMENTS=off disables it).
 */

const keyId = () => process.env.RAZORPAY_KEY_ID || ''
const keySecret = () => process.env.RAZORPAY_KEY_SECRET || ''
const apiBase = () => (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/$/, '')
const razorpayReady = () => !!(keyId() && keySecret())

/**
 * Demo gateway: used when no Razorpay keys are set (turn off with DEMO_PAYMENTS=off).
 * It behaves like a payment gateway: it issues order ids, "processes" a payment, and signs the result
 * with its own secret, so /verify checks a real HMAC signature exactly as it does for Razorpay.
 * No real money moves and no card details ever reach the server.
 */
const demoEnabled = () => !razorpayReady() && (process.env.DEMO_PAYMENTS || 'on').toLowerCase() !== 'off'
const demoSecret = () => hmacHex(process.env.JWT_SECRET || 'dev-only-secret', 'lofi-demo-gateway')
const configured = () => razorpayReady() || demoEnabled()
export const paymentMode = () => (razorpayReady() ? (keyId().startsWith('rzp_test_') ? 'razorpay_test' : 'razorpay_live') : demoEnabled() ? 'demo' : 'off')

const hmacHex = (secret, data) => createHmac('sha256', secret).update(data).digest('hex')
function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Marks an order paid and extends the user's Pro time, exactly once (safe to call twice). */
async function fulfil(orderId, paymentId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // lock the row so /verify and the webhook can't both apply the same payment
    const p = (await client.query(`SELECT id, user_id, plan, status FROM payments WHERE razorpay_order_id = $1 FOR UPDATE`, [orderId])).rows[0]
    if (!p) { await client.query('ROLLBACK'); return null }
    if (p.status === 'paid') { await client.query('COMMIT'); return { userId: p.user_id, already: true } }
    const days = PLANS[p.plan].days
    const u = await client.query(
      `UPDATE users SET pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => $2)
       WHERE id = $1 RETURNING pro_until`,
      [p.user_id, days],
    )
    await client.query(
      `UPDATE payments SET status = 'paid', razorpay_payment_id = $2, paid_at = now(), pro_until_after = $3 WHERE id = $1`,
      [p.id, paymentId, u.rows[0].pro_until],
    )
    await client.query('COMMIT')
    return { userId: p.user_id, already: false }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ---- webhook: no login cookie; authenticated by Razorpay's signature over the raw body ----
export const webhook = [
  express.raw({ type: 'application/json', limit: '1mb' }),
  wrap(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!secret) return res.status(404).json({ error: 'Webhook not configured' })
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
    if (!safeEqual(hmacHex(secret, raw), req.get('x-razorpay-signature') || '')) return res.status(400).json({ error: 'Bad signature' })
    let event
    try { event = JSON.parse(raw.toString('utf8')) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const payment = event?.payload?.payment?.entity
    const orderId = event?.payload?.order?.entity?.id || payment?.order_id
    if ((event.event === 'payment.captured' || event.event === 'order.paid') && orderId && payment?.id) {
      await fulfil(orderId, payment.id)
    } else if (event.event === 'payment.failed' && orderId) {
      await q(`UPDATE payments SET status = 'failed' WHERE razorpay_order_id = $1 AND status = 'created'`, [orderId])
    }
    res.json({ ok: true }) // always 200 for handled/ignored events so Razorpay stops retrying
  }),
]

const router = Router()
router.use(requireAuth)

router.get('/', wrap(async (req, res) => {
  const plan = await planOf(req.userId)
  const history = await q(
    `SELECT id, plan, amount, currency, status, provider, method, razorpay_payment_id AS "paymentId",
            ${ms('created_at')} AS "createdAt", ${ms('paid_at')} AS "paidAt", ${ms('pro_until_after')} AS "proUntilAfter"
     FROM payments WHERE user_id = $1 AND status <> 'created' ORDER BY created_at DESC LIMIT 20`,
    [req.userId],
  )
  res.json({
    configured: configured(),
    mode: paymentMode(),
    testMode: paymentMode() !== 'razorpay_live',
    plan,
    plans: Object.values(PLANS).map(p => ({ id: p.id, name: p.name, days: p.days, amount: p.amount, currency: 'INR' })),
    history: history.rows,
    limits: { freeDaily: LIMITS.free.dailyQuestions, proDaily: LIMITS.pro.dailyQuestions },
  })
}))

router.post('/orders', wrap(async (req, res) => {
  if (!configured()) throw new HttpError(503, 'Payments are not set up on this server yet. The site owner needs to add Razorpay keys (see DEPLOY.md).')
  const plan = PLANS[req.body.planId]
  if (!plan) throw new HttpError(400, 'Unknown plan')
  const u = (await q(`SELECT display_name, email FROM users WHERE id = $1`, [req.userId])).rows[0]
  const prefill = { name: u?.display_name ?? '', email: u?.email ?? '' }

  if (!razorpayReady()) {
    const orderId = `order_demo_${randomBytes(7).toString('hex')}`
    await q(
      `INSERT INTO payments (user_id, plan, amount, currency, razorpay_order_id, provider) VALUES ($1, $2, $3, 'INR', $4, 'demo')`,
      [req.userId, plan.id, plan.amount, orderId],
    )
    return res.json({ provider: 'demo', keyId: null, orderId, amount: plan.amount, currency: 'INR', planName: plan.name, prefill })
  }

  const receipt = `pro_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  let order
  try {
    const r = await fetch(`${apiBase()}/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId()}:${keySecret()}`).toString('base64')}`,
      },
      body: JSON.stringify({ amount: plan.amount, currency: 'INR', receipt, notes: { user_id: req.userId, plan: plan.id } }),
    })
    order = await r.json().catch(() => ({}))
    if (!r.ok) {
      console.error('[billing] Razorpay order failed:', r.status, order?.error?.description)
      throw new HttpError(502, r.status === 401 ? 'Razorpay rejected the server\'s keys. The site owner needs to check them.' : "Couldn't start the payment. Please try again.")
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(502, "Couldn't reach Razorpay. Please try again.")
  }
  await q(
    `INSERT INTO payments (user_id, plan, amount, currency, razorpay_order_id) VALUES ($1, $2, $3, 'INR', $4)`,
    [req.userId, plan.id, plan.amount, order.id],
  )
  res.json({
    provider: 'razorpay',
    keyId: keyId(),
    orderId: order.id,
    amount: plan.amount,
    currency: 'INR',
    planName: plan.name,
    prefill,
  })
}))

/**
 * The demo gateway "processes" a payment. The browser sends only the outcome of the test method
 * (never card numbers). Like a real gateway it returns a payment id and a signature, which the
 * browser then passes to /verify.
 */
router.post('/demo/pay', wrap(async (req, res) => {
  if (!demoEnabled()) throw new HttpError(404, 'Demo payments are switched off')
  const orderId = String(req.body?.orderId ?? '')
  const method = req.body?.method === 'upi' ? 'upi' : 'card'
  const outcome = req.body?.outcome === 'failure' ? 'failure' : 'success'
  const p = (await q(
    `SELECT id, status, razorpay_payment_id FROM payments WHERE razorpay_order_id = $1 AND user_id = $2 AND provider = 'demo'`,
    [orderId, req.userId],
  )).rows[0]
  if (!p) throw new HttpError(404, 'Order not found')
  // like a real gateway, an order can be paid only once
  if (p.status !== 'created' || p.razorpay_payment_id) throw new HttpError(409, 'This order has already been processed')
  await new Promise(r => setTimeout(r, 600)) // a gateway takes a moment
  await q(`UPDATE payments SET method = $2 WHERE id = $1`, [p.id, method])
  if (outcome === 'failure') {
    await q(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'created'`, [p.id])
    return res.status(402).json({
      error: method === 'upi' ? 'Payment declined by the UPI app.' : 'Your bank declined this card.',
      code: 'payment_failed',
    })
  }
  const paymentId = `pay_demo_${randomBytes(7).toString('hex')}`
  // remember which payment the gateway issued; the conditional update also stops two tabs paying at once
  const claimed = await q(
    `UPDATE payments SET razorpay_payment_id = $2 WHERE id = $1 AND status = 'created' AND razorpay_payment_id IS NULL`,
    [p.id, paymentId],
  )
  if (!claimed.rowCount) throw new HttpError(409, 'This order has already been processed')
  res.json({
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: hmacHex(demoSecret(), `${orderId}|${paymentId}`),
  })
}))

router.post('/verify', wrap(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {}
  if (![orderId, paymentId, signature].every(v => typeof v === 'string' && v.length > 0 && v.length < 200)) throw new HttpError(400, 'Missing payment details')
  // the order must be one this user created on our server
  const p = (await q(`SELECT id, provider, razorpay_payment_id FROM payments WHERE razorpay_order_id = $1 AND user_id = $2`, [orderId, req.userId])).rows[0]
  if (!p) throw new HttpError(404, 'Payment not found')
  if (p.provider === 'demo' && p.razorpay_payment_id !== paymentId) throw new HttpError(400, "We couldn't verify this payment, so Pro wasn't activated.")
  // each gateway signs with its own secret
  const secret = p.provider === 'demo' ? (demoEnabled() ? demoSecret() : null) : keySecret()
  if (!secret || !safeEqual(hmacHex(secret, `${orderId}|${paymentId}`), signature)) {
    await q(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'created'`, [p.id])
    throw new HttpError(400, "We couldn't verify this payment, so Pro wasn't activated. If money was deducted, contact support with your payment ID.")
  }
  await fulfil(orderId, paymentId)
  res.json({ ok: true, plan: await planOf(req.userId) })
}))

/** Called when checkout reports a failure or is closed, so the order isn't left 'created' forever. */
router.post('/failed', wrap(async (req, res) => {
  const orderId = String(req.body?.orderId ?? '')
  await q(`UPDATE payments SET status = 'failed' WHERE razorpay_order_id = $1 AND user_id = $2 AND status = 'created'`, [orderId, req.userId])
  res.json({ ok: true })
}))

export default router
