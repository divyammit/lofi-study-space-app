/**
 * AI provider layer for the study tutor.
 *
 * Pick a provider by adding ONE API key in the environment (or set AI_PROVIDER explicitly):
 *   GEMINI_API_KEY     Google Gemini   (free tier, no card needed)   model: GEMINI_MODEL
 *   ANTHROPIC_API_KEY  Anthropic Claude                              model: ANTHROPIC_MODEL
 *   OPENAI_API_KEY     OpenAI or any OpenAI-compatible API           model: OPENAI_MODEL, base: OPENAI_BASE_URL
 *
 * Every provider is used the same way: streamChat() calls onText() with each piece of the answer
 * as it arrives and resolves with the full text and token counts. Keys never leave the server.
 */

const PROVIDERS = {
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    label: 'Google Gemini',
  },
  anthropic: {
    key: () => process.env.ANTHROPIC_API_KEY,
    model: () => process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    label: 'Anthropic Claude',
  },
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    model: () => process.env.OPENAI_MODEL || '',
    label: 'OpenAI-compatible',
  },
}

export function aiConfig() {
  const chosen = (process.env.AI_PROVIDER || '').toLowerCase()
  const id = PROVIDERS[chosen] ? chosen : Object.keys(PROVIDERS).find(p => PROVIDERS[p].key())
  if (!id || !PROVIDERS[id].key()) return { configured: false }
  const model = PROVIDERS[id].model()
  if (!model) return { configured: false, problem: `Set ${id.toUpperCase()}_MODEL to the model you want to use.` }
  return { configured: true, provider: id, label: PROVIDERS[id].label, model }
}

export class AiError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

/** Friendly message for an upstream HTTP error. */
function upstreamError(status, detail) {
  if (status === 429) return new AiError('The AI service is busy or its usage limit was reached. Please try again in a little while.', { status: 503, retryable: true })
  if (status === 401 || status === 403) return new AiError('The AI service rejected the server\'s API key. The site owner needs to check it.', { status: 503 })
  if (status === 400 || status === 404) return new AiError(`The AI service couldn't handle that request${detail ? `: ${detail}` : ''}.`, { status: 502 })
  if (status >= 500) return new AiError('The AI service is having trouble right now. Please try again.', { status: 503, retryable: true })
  return new AiError(`The AI service returned an error (${status}).`)
}

async function readError(res) {
  try {
    const j = await res.json()
    return j?.error?.message || j?.message || ''
  } catch { return '' }
}

/** Reads a Server-Sent Events stream and calls onData with each "data:" payload. */
async function readSse(body, onData) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
      const data = chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (data) onData(data)
    }
  }
  const tail = buf.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
  if (tail) onData(tail)
}

const parseJson = s => { try { return JSON.parse(s) } catch { return null } }

/**
 * messages: [{ role: 'user' | 'assistant', text, image?: { mime, data } }]  (data = base64, no prefix)
 */
export async function streamChat({ system, messages, maxTokens = 1200, signal, onText }) {
  const cfg = aiConfig()
  if (!cfg.configured) throw new AiError('The AI tutor is not set up on this server yet.', { status: 503 })
  const fn = { gemini: gemini, anthropic: anthropic, openai: openai }[cfg.provider]
  try {
    return await fn({ cfg, system, messages, maxTokens, signal, onText })
  } catch (e) {
    if (e instanceof AiError || e.name === 'AbortError') throw e
    console.error('[ai]', e)
    throw new AiError("Couldn't reach the AI service. Please try again.", { status: 503, retryable: true })
  }
}

// ---------------- Google Gemini ----------------
async function gemini({ cfg, system, messages, maxTokens, signal, onText }) {
  const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': PROVIDERS.gemini.key() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [...(m.image ? [{ inlineData: { mimeType: m.image.mime, data: m.image.data } }] : []), { text: m.text || ' ' }],
      })),
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5 },
    }),
  })
  if (!res.ok) throw upstreamError(res.status, await readError(res))
  let text = ''
  let usage = {}
  let blocked = ''
  await readSse(res.body, data => {
    const j = parseJson(data)
    if (!j) return
    if (j.error) throw upstreamError(j.error.code || 500, j.error.message)
    const cand = j.candidates?.[0]
    for (const p of cand?.content?.parts ?? []) {
      if (p.thought || typeof p.text !== 'string') continue // skip the model's hidden reasoning
      text += p.text
      onText(p.text)
    }
    if (cand?.finishReason === 'SAFETY' || j.promptFeedback?.blockReason) blocked = 'safety'
    if (j.usageMetadata) usage = { in: j.usageMetadata.promptTokenCount, out: j.usageMetadata.candidatesTokenCount }
  })
  if (!text && blocked) throw new AiError("The AI declined to answer that one. Try rephrasing your question.", { status: 422 })
  return { text, tokensIn: usage.in ?? null, tokensOut: usage.out ?? null }
}

// ---------------- Anthropic Claude ----------------
async function anthropic({ cfg, system, messages, maxTokens, signal, onText }) {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': PROVIDERS.anthropic.key(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      stream: true,
      messages: messages.map(m => ({
        role: m.role,
        content: [
          ...(m.image ? [{ type: 'image', source: { type: 'base64', media_type: m.image.mime, data: m.image.data } }] : []),
          { type: 'text', text: m.text || ' ' },
        ],
      })),
    }),
  })
  if (!res.ok) throw upstreamError(res.status, await readError(res))
  let text = ''
  const usage = {}
  await readSse(res.body, data => {
    const j = parseJson(data)
    if (!j) return
    if (j.type === 'error') throw upstreamError(j.error?.type === 'overloaded_error' ? 503 : 500, j.error?.message)
    if (j.type === 'message_start') usage.in = j.message?.usage?.input_tokens
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
      text += j.delta.text
      onText(j.delta.text)
    }
    if (j.type === 'message_delta' && j.usage) usage.out = j.usage.output_tokens
  })
  return { text, tokensIn: usage.in ?? null, tokensOut: usage.out ?? null }
}

// ---------------- OpenAI-compatible (OpenAI, Groq, OpenRouter, ...) ----------------
async function openai({ cfg, system, messages, maxTokens, signal, onText }) {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROVIDERS.openai.key()}` },
    body: JSON.stringify({
      model: cfg.model,
      stream: true,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role,
          content: m.image
            ? [{ type: 'text', text: m.text || ' ' }, { type: 'image_url', image_url: { url: `data:${m.image.mime};base64,${m.image.data}` } }]
            : m.text || ' ',
        })),
      ],
    }),
  })
  if (!res.ok) throw upstreamError(res.status, await readError(res))
  let text = ''
  const usage = {}
  await readSse(res.body, data => {
    if (data === '[DONE]') return
    const j = parseJson(data)
    if (!j) return
    if (j.error) throw upstreamError(500, j.error.message)
    const piece = j.choices?.[0]?.delta?.content
    if (typeof piece === 'string' && piece) {
      text += piece
      onText(piece)
    }
    if (j.usage) { usage.in = j.usage.prompt_tokens; usage.out = j.usage.completion_tokens }
  })
  return { text, tokensIn: usage.in ?? null, tokensOut: usage.out ?? null }
}

export function logAiSetup() {
  const c = aiConfig()
  if (c.configured) console.log(`[ai] Study tutor using ${c.label} (${c.model}).`)
  else console.log(`[ai] Study tutor not configured${c.problem ? `: ${c.problem}` : '. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY). See DEPLOY.md.'}`)
}
