import { createDecipheriv, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadImage } from '../src/media.js'

afterEach(() => { vi.unstubAllGlobals() })

const png = Buffer.from('89504e470d0a1a0a-pretend-this-is-an-image', 'utf8')

function cdnResponse(encryptedParam = 'encrypted-param-a'): Response {
  return new Response('', { status: 200, headers: { 'x-encrypted-param': encryptedParam } })
}

describe('outbound media', () => {
  it('reserves an upload with the plaintext digest and the ciphertext size', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0, upload_full_url: 'https://cdn.example.test/upload?signed',
      }), { status: 200 }))
      .mockResolvedValueOnce(cdnResponse())
    vi.stubGlobal('fetch', fetchMock)

    const uploaded = await uploadImage({
      baseUrl: 'https://ilink.example.test',
      token: 'bot-token',
      userId: 'peer-a',
      bytes: png,
      cdnBaseUrl: 'https://cdn.example.test/c2c',
    })

    const [reserveUrl, reserveInit] = fetchMock.mock.calls[0]!
    expect(String(reserveUrl)).toContain('/ilink/bot/getuploadurl')
    const reservation = JSON.parse(String(reserveInit?.body)) as Record<string, unknown>
    expect(reservation).toMatchObject({
      media_type: 1,
      to_user_id: 'peer-a',
      rawsize: png.length,
      rawfilemd5: createHash('md5').update(png).digest('hex'),
      no_need_thumb: true,
    })
    // getuploadurl wants the key as hex while the send-ready reference carries the
    // same bytes in base64; a mismatch here renders as a broken image, not an error.
    expect(reservation.aeskey).toMatch(/^[0-9a-f]{32}$/u)
    expect(reservation.filesize).toBe(uploaded.midSize)
    expect(uploaded.midSize).toBe(Math.floor(png.length / 16 + 1) * 16)
    expect(uploaded.media).toEqual({
      encrypt_query_param: 'encrypted-param-a',
      aes_key: Buffer.from(String(reservation.aeskey), 'hex').toString('base64'),
      encrypt_type: 1,
    })
  })

  it('uploads ciphertext the receiver can decrypt with the advertised key', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        upload_full_url: 'https://cdn.example.test/upload?signed',
      }), { status: 200 }))
      .mockResolvedValueOnce(cdnResponse())
    vi.stubGlobal('fetch', fetchMock)

    const uploaded = await uploadImage({
      baseUrl: 'https://ilink.example.test',
      token: 'bot-token',
      userId: 'peer-a',
      bytes: png,
      cdnBaseUrl: 'https://cdn.example.test/c2c',
    })

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1]!
    expect(String(uploadUrl)).toBe('https://cdn.example.test/upload?signed')
    expect(uploadInit?.method).toBe('POST')
    expect(new Headers(uploadInit?.headers).get('Content-Type')).toBe('application/octet-stream')
    const ciphertext = Buffer.from(uploadInit?.body as Uint8Array)
    expect(ciphertext).toHaveLength(uploaded.midSize)
    const decipher = createDecipheriv(
      'aes-128-ecb', Buffer.from(uploaded.media.aes_key!, 'base64'), null)
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toEqual(png)
  })

  it('builds the upload URL from the signed parameter when no full URL is offered', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ upload_param: 'signed=abc' }), { status: 200 }))
      .mockResolvedValueOnce(cdnResponse())
    vi.stubGlobal('fetch', fetchMock)

    await uploadImage({
      baseUrl: 'https://ilink.example.test',
      token: 'bot-token',
      userId: 'peer-a',
      bytes: png,
      cdnBaseUrl: 'https://cdn.example.test/c2c',
    })

    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://cdn.example.test/c2c/upload?signed=abc')
  })

  it.each([
    {
      name: 'the reservation is rejected',
      reserve: new Response(JSON.stringify({ ret: 40001, errmsg: 'invalid token' }), { status: 200 }),
      upload: cdnResponse(),
      message: /getuploadurl ret=40001/u,
    },
    {
      name: 'the CDN rejects the upload',
      reserve: new Response(JSON.stringify({ upload_full_url: 'https://cdn.example.test/upload' }), { status: 200 }),
      upload: new Response('', { status: 500 }),
      message: /media upload returned HTTP 500/u,
    },
    {
      name: 'the CDN omits the download reference',
      reserve: new Response(JSON.stringify({ upload_full_url: 'https://cdn.example.test/upload' }), { status: 200 }),
      upload: new Response('', { status: 200 }),
      message: /no x-encrypted-param/u,
    },
    {
      name: 'no upload target is offered',
      reserve: new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
      upload: cdnResponse(),
      message: /no upload target/u,
    },
  ])('fails loudly when $name', async ({ reserve, upload, message }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reserve)
      .mockResolvedValueOnce(upload))

    await expect(uploadImage({
      baseUrl: 'https://ilink.example.test',
      token: 'bot-token',
      userId: 'peer-a',
      bytes: png,
      cdnBaseUrl: 'https://cdn.example.test/c2c',
    })).rejects.toThrow(message)
  })
})
