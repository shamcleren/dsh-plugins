export const LIVE_PATH = '/api/saas-agent/live'
export const LIVE_TYPE = 'application/octet-stream'
export const FRAME_HEADER_BYTES = 16
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const INITIAL_VIEWPORT = { width: 1280, height: 900 }

export interface LiveSurface { width: number; height: number; epoch: number }
export interface LiveFrame extends LiveSurface { jpeg: Uint8Array<ArrayBuffer> }
