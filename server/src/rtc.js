/**
 * ICE servers for WebRTC calls.
 *  - STUN (free, always on) lets browsers discover their public address.
 *  - TURN (optional) relays audio/video when networks block direct connections
 *    (mobile data, college/office Wi-Fi). Without it, those calls connect but stay silent.
 *
 * Configure ONE of these in the environment:
 *  1. ICE_SERVERS_JSON   paste the iceServers array your TURN provider shows you
 *  2. TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
 *  3. CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN (short-lived credentials fetched automatically)
 */
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }

/**
 * Accepts strict JSON or the JavaScript snippet providers show, e.g.
 *   const pc = new RTCPeerConnection({ iceServers: [ { urls: "turn:...", username: "...", credential: "..." }, ] })
 */
export function parseIceServers(raw) {
  if (!raw) return []
  let text = raw.trim()
  const tryParse = t => { try { return JSON.parse(t) } catch { return undefined } }
  let v = tryParse(text)
  if (v === undefined) {
    const a = text.indexOf('['), b = text.lastIndexOf(']')
    if (a >= 0 && b > a) text = text.slice(a, b + 1)
    else { const c = text.indexOf('{'), d = text.lastIndexOf('}'); if (c >= 0 && d > c) text = text.slice(c, d + 1) }
    const loose = text
      .replace(/\/\/[^\n]*/g, '')                          // // comments
      .replace(/'([^'\\]*)'/g, '"$1"')                    // 'single' -> "double" quotes
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // unquoted keys
      .replace(/,\s*([}\]])/g, '$1')                        // trailing commas
    v = tryParse(loose)
  }
  if (v === undefined) throw new Error('could not read it as JSON or as a JavaScript snippet')
  const list = Array.isArray(v) ? v : Array.isArray(v?.iceServers) ? v.iceServers : v?.urls ? [v] : []
  return list.filter(x => x && (typeof x.urls === 'string' || Array.isArray(x.urls)))
}

function fromJsonEnv() {
  try {
    return parseIceServers(process.env.ICE_SERVERS_JSON)
  } catch (e) {
    console.error('[rtc] ICE_SERVERS_JSON:', e.message)
    return []
  }
}

function fromTurnEnv() {
  if (!process.env.TURN_URLS) return []
  return [{
    urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  }]
}

let cfCache = { servers: [], until: 0 }
async function fromCloudflare() {
  const id = process.env.CLOUDFLARE_TURN_KEY_ID
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN
  if (!id || !token) return []
  if (Date.now() < cfCache.until) return cfCache.servers
  // credentials last 24h; refresh every 12h
  for (const path of ['generate-ice-servers', 'generate']) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      })
      if (!r.ok) continue
      const data = await r.json()
      const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : []
      if (list.length) {
        cfCache = { servers: list, until: Date.now() + 12 * 3600_000 }
        return list
      }
    } catch (e) {
      console.error('[rtc] Cloudflare TURN request failed:', e.message)
    }
  }
  console.error('[rtc] Could not get Cloudflare TURN credentials. Check CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN.')
  return []
}

const hasTurn = list => list.some(s => [].concat(s.urls).some(u => /^turns?:/i.test(u)))

export async function iceServers() {
  const extra = [...fromJsonEnv(), ...fromTurnEnv(), ...(await fromCloudflare())]
  const servers = [STUN, ...extra]
  return { iceServers: servers, relay: hasTurn(servers) }
}

export function logRtcSetup() {
  const configured = !!(process.env.ICE_SERVERS_JSON || process.env.TURN_URLS || process.env.CLOUDFLARE_TURN_KEY_ID)
  console.log(configured
    ? '[rtc] TURN relay configured: calls will also work on strict networks.'
    : '[rtc] No TURN relay configured: calls may be silent on mobile data / strict Wi-Fi. See DEPLOY.md.')
}
