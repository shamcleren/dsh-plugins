import { describe, expect, it } from 'vitest'
import { isImageBytes, mediaFailure, MediaDeliveryError } from '../../src/adapters/wechat/media-delivery.js'
import { WeChatSendError } from '../../src/adapters/wechat/api.js'

describe('media delivery diagnostics and classification', () => {
  it.each(['ffd8ffe000', '89504e470d0a1a0a', '474946383961', '524946460400000057454250'])('recognizes raster signature %s', hex => {
    expect(isImageBytes(Buffer.from(hex, 'hex'))).toBe(true)
  })
  it.each(['', 'hello.jpg', '<svg/>', '%PDF-1.7'])('does not treat non-raster bytes as images', text => {
    expect(isImageBytes(Buffer.from(text))).toBe(false)
  })
  it('does not retain sensitive exception text or causes', () => {
    const original = new Error('/private/user/file.jpg token=secret https://cdn.test/?signed=secret')
    const failure = mediaFailure('read', original)
    expect(failure.message).toBe('wechat: media delivery failed stage=read category=unknown')
    expect(failure.cause).toBeUndefined()
    expect(mediaFailure('send', new WeChatSendError('uncertain')).category).toBe('uncertain')
    expect(mediaFailure('send', new MediaDeliveryError('upload', 'timeout')).stage).toBe('upload')
  })
})
