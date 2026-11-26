/**
 * Sending email (password reset links).
 *
 * Uses Brevo's HTTPS email API. Render's free plan blocks the normal email (SMTP) ports, so an
 * HTTPS API is the way that works there. Free Brevo accounts can send 300 emails a day.
 *
 *   BREVO_API_KEY   your Brevo API key (Brevo → SMTP & API → API keys)
 *   MAIL_FROM       the sender address you verified in Brevo (e.g. your Gmail)
 *   MAIL_FROM_NAME  optional sender name, default "Lo-Fi Study Space"
 *   APP_URL         optional: the site's public address for links in emails. On Render this is
 *                   detected automatically (RENDER_EXTERNAL_URL).
 *
 * Without BREVO_API_KEY nothing is emailed; reset links are written to the server log instead,
 * so the site owner can pass them on by hand.
 */

const API = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email'

export const mailReady = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM)

/**
 * Public address of the site, used to build links in emails. Never taken from the request's
 * Host header: an attacker could fake it and receive someone else's reset link.
 */
export function appUrl() {
  const first = (process.env.CLIENT_ORIGIN || '').split(',')[0]?.trim()
  const url = process.env.APP_URL || first || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`
  return url.replace(/\/$/, '')
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** A simple email that looks like the app: dark card, amber button. */
export function emailLayout({ title, intro, button, link, outro }) {
  const html = `<!doctype html><html><body style="margin:0;background:#141626;padding:24px;font-family:Menlo,Consolas,monospace;color:#ece3d0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:480px;background:#1e2135;border:3px solid #3a3f5c" cellspacing="0" cellpadding="0">
    <tr><td style="padding:24px">
      <div style="font-size:13px;color:#a59c8a;letter-spacing:1px">LO-FI STUDY SPACE</div>
      <h1 style="font-size:22px;margin:8px 0 16px;color:#ece3d0">${esc(title)}</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px">${esc(intro)}</p>
      ${button && link ? `<a href="${esc(link)}" style="display:inline-block;background:#f2a65a;color:#2a1c10;text-decoration:none;padding:12px 20px;font-size:16px;font-weight:bold">${esc(button)}</a>
      <p style="font-size:12px;color:#a59c8a;margin:20px 0 0;word-break:break-all">Or paste this into your browser:<br>${esc(link)}</p>` : ''}
      ${outro ? `<p style="font-size:13px;color:#a59c8a;line-height:1.5;margin:20px 0 0">${esc(outro)}</p>` : ''}
    </td></tr>
  </table></td></tr></table></body></html>`
  const text = [title, '', intro, ...(link ? ['', `${button}: ${link}`] : []), ...(outro ? ['', outro] : [])].join('\n')
  return { html, text }
}

/** Send one email. Returns false (without throwing) when email isn't set up. */
export async function sendMail({ to, subject, html, text }) {
  if (!mailReady()) return false
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || 'Lo-Fi Study Space', email: process.env.MAIL_FROM },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new Error(`Brevo answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return true
}

export function logMailSetup() {
  if (mailReady()) console.log(`[mail] Emails sent through Brevo from ${process.env.MAIL_FROM}. Links point to ${appUrl()}.`)
  else console.log('[mail] Email not set up: password reset links will be printed in this log. Add BREVO_API_KEY and MAIL_FROM (see DEPLOY.md).')
}
