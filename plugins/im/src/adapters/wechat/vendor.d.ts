declare module 'qrcode/lib/browser.js' {
  interface QrOptions {
    type: 'svg'
    width?: number
    margin?: number
  }

  const QRCode: {
    toString(text: string, options: QrOptions): Promise<string>
  }

  export default QRCode
}
