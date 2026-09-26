/**
 * Save a generated file. Inside a published claude.ai artifact, uses the viewer's
 * `downloads` capability; anywhere else (local dev, your own hosting) falls back
 * to a normal <a download> link.
 */
type DownloadsNS = { save(req: { filename: string; data: Blob | string }): Promise<unknown> }
type ClaudeHost = { use(name: string): Promise<unknown> }

export async function saveFile(filename: string, data: Blob): Promise<'saved' | 'declined' | 'failed'> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude
  if (host?.use) {
    try {
      const dl = (await host.use('downloads')) as DownloadsNS | null
      if (dl) {
        try { await dl.save({ filename, data }); return 'saved' } catch (e) {
          const code = (e as { code?: string })?.code
          return code === 'declined' ? 'declined' : 'failed'
        }
      }
    } catch { /* fall through */ }
  }
  try {
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return 'saved'
  } catch { return 'failed' }
}
