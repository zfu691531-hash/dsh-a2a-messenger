import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Connect-code codec for direct sessions. A code carries one side's WebRTC
 * session description (with ICE candidates, non-trickle) plus a display name,
 * compressed and base64url-encoded so it survives chat apps intact.
 */

export interface DirectPayload {
  v: 1
  role: 'offer' | 'answer'
  name: string
  sdp: string
}

const PREFIX = 'A2A1-'

export function encodeCode(payload: DirectPayload): string {
  const packed = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  return PREFIX + packed.toString('base64url')
}

export function decodeCode(code: string): DirectPayload | undefined {
  const trimmed = code.trim()
  if (!trimmed.startsWith(PREFIX)) return undefined
  try {
    const packed = Buffer.from(trimmed.slice(PREFIX.length), 'base64url')
    const raw = JSON.parse(inflateRawSync(packed).toString('utf8')) as DirectPayload
    if (raw.v !== 1) return undefined
    if (raw.role !== 'offer' && raw.role !== 'answer') return undefined
    if (typeof raw.name !== 'string' || typeof raw.sdp !== 'string' || raw.sdp.length === 0) {
      return undefined
    }
    return raw
  } catch {
    return undefined
  }
}
