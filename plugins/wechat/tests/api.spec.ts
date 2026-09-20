import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestQrCode, requestQrStatus, sendMessage } from '../src/api.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('iLink API', () => {
  it('requests an official bot QR code with local account tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      qrcode: 'opaque-code', qrcode_img_content: 'https://qr.example.test',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestQrCode('https://ilink.example.test', ['token-a'])).resolves.toEqual({
      qrcode: 'opaque-code', qrcode_img_content: 'https://qr.example.test',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(JSON.parse(String(init?.body))).toEqual({ local_token_list: ['token-a'] })
  })

  it('sends the current peer context token with a completed text message', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendMessage({
      baseUrl: 'https://ilink.example.test', token: 'bot-token', userId: 'peer-a',
      contextToken: 'context-a', item: { type: 1, text_item: { text: 'hello' } },
    })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body)) as { msg: Record<string, unknown> }
    expect(body.msg).toMatchObject({
      to_user_id: 'peer-a', context_token: 'context-a', message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer bot-token')
  })

  it('treats a QR long-poll timeout as an unchanged waiting state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timed out', 'TimeoutError')))

    await expect(requestQrStatus('https://ilink.example.test', 'opaque-code')).resolves.toEqual({ status: 'wait' })
  })
})
