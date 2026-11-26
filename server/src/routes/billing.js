import { Router } from 'express'
import express from 'express'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ms, pool, q } from '../db.js'
import { HttpError, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { LIMITS, PLANS, planOf } from '../plans.js'
import { realtime } from '../realtime.js'

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
/**
 * UPI QR payments to the team's own UPI ID (UPI_ID, UPI_PAYEE_NAME). Real money: the payer scans a QR with the
 * amount pre-filled, submits their UPI reference (UTR), and a team member listed in ADMIN_USERNAMES approves it.
 */
const upiId = () => (process.env.UPI_ID || '').trim()
const upiReady = () => !razorpayReady() && /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(upiId())
const upiPayee = () => (process.env.UPI_PAYEE_NAME || 'Lo-Fi Study Space').trim().slice(0, 50)
const adminNames = () => (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
export async function isAdmin(userId) {
  const names = adminNames()
  if (!names.length) return false
  const r = await q(`SELECT 1 FROM users WHERE id = $1 AND lower(username) = ANY($2::text[])`, [userId, names])
  return r.rowCount > 0
}

const demoEnabled = () => !razorpayReady() && !upiReady() && (process.env.DEMO_PAYMENTS || 'on').toLowerCase() !== 'off'
const demoSecret = () => hmacHex(process.env.JWT_SECRET || 'dev-only-secret', 'lofi-demo-gateway')
const configured = () => razorpayReady() || upiReady() || demoEnabled()
export const paymentMode = () => (razorpayReady() ? (keyId().startsWith('rzp_test_') ? 'razorpay_test' : 'razorpay_live') : upiReady() ? 'upi' : demoEnabled() ? 'demo' : 'off')

/** The upi:// link encoded in the QR: payee, exact amount, and the order's reference in the note. */
const upiLink = (amountPaise, reference) => {
  // the @ in the UPI ID stays unencoded: some UPI apps don't decode %40
  return `upi://pay?pa=${upiId()}&pn=${encodeURIComponent(upiPayee())}&am=${(amountPaise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`LoFi Pro ${reference}`)}`
}
// readable, unambiguous code (no 0/O, 1/I)
const makeReference = () => 'LOFI-' + Array.from(randomBytes(6), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')

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
    `SELECT id, plan, amount, currency, status, provider, method, razorpay_payment_id AS "paymentId", razorpay_order_id AS "orderId", reference, utr, review_note AS "reviewNote",
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
    isAdmin: await isAdmin(req.userId),
  })
}))

router.post('/orders', wrap(async (req, res) => {
  if (!configured()) throw new HttpError(503, 'Payments are not set up on this server yet. The site owner needs to add Razorpay keys (see DEPLOY.md).')
  const plan = PLANS[req.body.planId]
  if (!plan) throw new HttpError(400, 'Unknown plan')
  const u = (await q(`SELECT display_name, email FROM users WHERE id = $1`, [req.userId])).rows[0]
  const prefill = { name: u?.display_name ?? '', email: u?.email ?? '' }

  if (upiReady()) {
    const orderId = `order_upi_${randomBytes(7).toString('hex')}`
    await q(
      `INSERT INTO payments (user_id, plan, amount, currency, razorpay_order_id, provider, method, reference)
       VALUES ($1, $2, $3, 'INR', $4, 'upi', 'upi', $5)`,
      [req.userId, plan.id, plan.amount, orderId, makeReference()],
    )
    return res.json({ provider: 'upi', keyId: null, orderId, amount: plan.amount, currency: 'INR', planName: plan.name, prefill })
  }

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

// ---------------- UPI QR payments ----------------
const ORDER_COLS = `p.razorpay_order_id AS "orderId", p.plan, p.amount, p.currency, p.status, p.provider, p.reference, p.utr,
  p.review_note AS "reviewNote", ${ms('p.created_at')} AS "createdAt", ${ms('p.claimed_at')} AS "claimedAt", ${ms('p.paid_at')} AS "paidAt",
  ${ms('p.pro_until_after')} AS "proUntilAfter"`

/** Everything the checkout page shows for one order (the payer's own orders only). */
router.get('/orders/:orderId', wrap(async (req, res) => {
  const p = (await q(`SELECT ${ORDER_COLS} FROM payments p WHERE p.razorpay_order_id = $1 AND p.user_id = $2`, [String(req.params.orderId), req.userId])).rows[0]
  if (!p) throw new HttpError(404, 'Order not found')
  const plan = PLANS[p.plan]
  res.json({
    ...p,
    planName: plan?.name ?? p.plan,
    planDays: plan?.days ?? null,
    upi: p.provider === 'upi' && upiReady() ? { payee: upiPayee(), vpa: upiId(), link: upiLink(p.amount, p.reference), note: `LoFi Pro ${p.reference}` } : null,
  })
}))

/** The payer says they've paid and gives their UPI reference number. A team member then checks it. */
router.post('/upi/claim', wrap(async (req, res) => {
  const orderId = String(req.body?.orderId ?? '')
  const utr = String(req.body?.utr ?? '').replace(/\s+/g, '')
  if (!/^\d{12}$/.test(utr)) throw new HttpError(400, 'Enter the 12-digit UPI reference number (UTR) from your payment app.')
  const p = (await q(`SELECT id, status, provider, plan, amount, reference FROM payments WHERE razorpay_order_id = $1 AND user_id = $2`, [orderId, req.userId])).rows[0]
  if (!p || p.provider !== 'upi') throw new HttpError(404, 'Order not found')
  if (p.status === 'pending') throw new HttpError(409, "You've already submitted this payment. It's being verified.")
  if (p.status === 'paid') throw new HttpError(409, 'This order is already paid.')
  if (p.status === 'failed') throw new HttpError(409, 'This order was closed. Start a new payment from the Pro panel.')
  let updated
  try {
    updated = await q(
      `UPDATE payments SET status = 'pending', utr = $2, claimed_at = now() WHERE id = $1 AND status = 'created' RETURNING id`,
      [p.id, utr],
    )
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'That UPI reference number has already been used for another payment.')
    throw e
  }
  if (!updated.rowCount) throw new HttpError(409, 'This order has already been processed.')
  // tell any team member who's online
  const names = adminNames()
  if (names.length) {
    const admins = await q(`SELECT id FROM users WHERE lower(username) = ANY($1::text[])`, [names])
    const who = (await q(`SELECT display_name FROM users WHERE id = $1`, [req.userId])).rows[0]?.display_name ?? 'Someone'
    admins.rows.forEach(a => realtime.emitToUser(a.id, 'billing:review', { name: who, amount: p.amount, reference: p.reference }))
  }
  res.json({ ok: true, status: 'pending' })
}))

// ---- team review (ADMIN_USERNAMES) ----
async function requireAdmin(req) {
  if (!(await isAdmin(req.userId))) throw new HttpError(403, 'Only the team can review payments.')
}

router.get('/admin/pending', wrap(async (req, res) => {
  await requireAdmin(req)
  const r = await q(
    `SELECT p.id, ${ORDER_COLS}, u.username, u.display_name AS name, u.email
     FROM payments p JOIN users u ON u.id = p.user_id
     WHERE p.provider = 'upi' AND p.status = 'pending' ORDER BY p.claimed_at`,
  )
  const recent = await q(
    `SELECT p.id, ${ORDER_COLS}, u.username, u.display_name AS name, r.display_name AS "reviewedBy", ${ms('p.reviewed_at')} AS "reviewedAt"
     FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN users r ON r.id = p.reviewed_by
     WHERE p.provider = 'upi' AND p.reviewed_at IS NOT NULL ORDER BY p.reviewed_at DESC LIMIT 10`,
  )
  res.json({ pending: r.rows.map(x => ({ ...x, planName: PLANS[x.plan]?.name ?? x.plan })), recent: recent.rows.map(x => ({ ...x, planName: PLANS[x.plan]?.name ?? x.plan })), payee: upiReady() ? { vpa: upiId(), name: upiPayee() } : null })
}))

router.post('/admin/:id/approve', wrap(async (req, res) => {
  await requireAdmin(req)
  const p = (await q(`SELECT id, user_id, razorpay_order_id, utr, status FROM payments WHERE id = $1 AND provider = 'upi'`, [String(req.params.id)])).rows[0]
  if (!p) throw new HttpError(404, 'Payment not found')
  if (p.status !== 'pending') throw new HttpError(409, p.status === 'paid' ? 'Already approved.' : 'This payment is no longer waiting for review.')
  await fulfil(p.razorpay_order_id, `upi_${p.utr}`)
  await q(`UPDATE payments SET reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [p.id, req.userId])
  realtime.emitToUser(p.user_id, 'billing:updated', { orderId: p.razorpay_order_id, status: 'paid' })
  res.json({ ok: true })
}))

router.post('/admin/:id/reject', wrap(async (req, res) => {
  await requireAdmin(req)
  const note = String(req.body?.note ?? '').trim().slice(0, 200) || "We couldn't find this payment. Check the UPI reference number and try again."
  const r = await q(
    `UPDATE payments SET status = 'failed', reviewed_by = $2, reviewed_at = now(), review_note = $3
     WHERE id = $1 AND provider = 'upi' AND status = 'pending' RETURNING user_id, razorpay_order_id`,
    [String(req.params.id), req.userId, note],
  )
  if (!r.rowCount) throw new HttpError(409, 'This payment is no longer waiting for review.')
  realtime.emitToUser(r.rows[0].user_id, 'billing:updated', { orderId: r.rows[0].razorpay_order_id, status: 'failed' })
  res.json({ ok: true })
}))

export default router
