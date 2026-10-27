/**
 * PNG construction helpers for tests.
 *
 * Deliberately implemented independently of `src/png.ts` (different CRC routine,
 * different chunk writer) so that a round-trip test exercises two separate
 * implementations rather than the same bug twice.
 */

import zlib from 'node:zlib'

export interface RgbColor {
  r: number
  g: number
  b: number
}

export type ColorType = 0 | 2 | 4 | 6

const CHANNELS: Record<ColorType, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export function crc32Bitwise(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build one PNG chunk, for tests that need unusual headers. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32Bitwise(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

export const PNG_SIGNATURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  return pngChunk(type, data)
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Apply one PNG row filter to a raw scanline. */
function applyFilter(
  filter: 0 | 1 | 2 | 3 | 4,
  row: Buffer,
  previous: Buffer,
  channels: number,
): Buffer {
  const out = Buffer.alloc(row.length)
  for (let index = 0; index < row.length; index += 1) {
    const value = row[index]!
    const left = index >= channels ? row[index - channels]! : 0
    const up = previous[index] ?? 0
    const upLeft = index >= channels ? (previous[index - channels] ?? 0) : 0
    switch (filter) {
      case 0:
        out[index] = value
        break
      case 1:
        out[index] = (value - left) & 0xff
        break
      case 2:
        out[index] = (value - up) & 0xff
        break
      case 3:
        out[index] = (value - ((left + up) >> 1)) & 0xff
        break
      case 4:
        out[index] = (value - paeth(left, up, upLeft)) & 0xff
        break
    }
  }
  return out
}

export interface MakePngOptions {
  width: number
  height: number
  colorType?: ColorType
  /** Row filter to encode with; exercised by the decoder tests. */
  filter?: 0 | 1 | 2 | 3 | 4
  /** Returns the channel samples for one pixel. */
  pixel: (x: number, y: number) => number[]
}

export function makePng(options: MakePngOptions): Buffer {
  const { width, height } = options
  const colorType = options.colorType ?? 2
  const channels = CHANNELS[colorType]
  const filter = options.filter ?? 0
  const stride = width * channels

  const rows: Buffer[] = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride)
    for (let x = 0; x < width; x += 1) {
      const samples = options.pixel(x, y)
      for (let channel = 0; channel < channels; channel += 1) {
        row[x * channels + channel] = (samples[channel] ?? 0) & 0xff
      }
    }
    rows.push(Buffer.concat([Buffer.from([filter]), applyFilter(filter, row, previous, channels)]))
    previous = row
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = colorType
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE_BYTES,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A one-colour PNG: the shape of a failed capture. */
export function solidPng(width: number, height: number, color: RgbColor, colorType: ColorType = 2): Buffer {
  return makePng({
    width,
    height,
    colorType,
    pixel: () => {
      const base = [color.r, color.g, color.b]
      if (colorType === 0) return [color.r]
      if (colorType === 4) return [color.r, 255]
      if (colorType === 6) return [...base, 255]
      return base
    },
  })
}

/**
 * A PNG with two vertical halves: useful for proving that a specific image was
 * captured instead of an arbitrary screenshot.
 */
export function splitPng(
  width: number,
  height: number,
  left: RgbColor,
  right: RgbColor,
): Buffer {
  return makePng({
    width,
    height,
    pixel: (x) => (x < width / 2 ? [left.r, left.g, left.b] : [right.r, right.g, right.b]),
  })
}

/** Cut a PNG short so that the final chunk is incomplete. */
export function truncatePng(buffer: Buffer, keepFraction = 0.6): Buffer {
  return buffer.subarray(0, Math.max(9, Math.floor(buffer.length * keepFraction)))
}

/** Flip a byte inside the IHDR payload so its CRC no longer matches. */
export function corruptHeaderCrc(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer)
  copy[20] = copy[20]! ^ 0xff
  return copy
}

/** Replace the signature with arbitrary bytes. */
export function breakSignature(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer)
  copy[0] = 0x00
  return copy
}
