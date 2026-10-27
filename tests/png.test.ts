import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import {
  analyzeImage,
  colorShare,
  decodePng,
  pixelAt,
  readPngHeader,
} from '../src/png.js'
import { ScreenshotError } from '../src/errors.js'
import {
  PNG_SIGNATURE_BYTES,
  breakSignature,
  corruptHeaderCrc,
  makePng,
  pngChunk,
  solidPng,
  splitPng,
  truncatePng,
} from './helpers/png.js'

const MAGENTA = { r: 255, g: 0, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }
const WHITE = { r: 255, g: 255, b: 255 }

function expectInvalid(png: Buffer, code = 'INVALID_PNG'): ScreenshotError {
  try {
    decodePng(png)
  } catch (error) {
    expect(error).toBeInstanceOf(ScreenshotError)
    expect((error as ScreenshotError).code).toBe(code)
    return error as ScreenshotError
  }
  throw new Error('expected the PNG to be rejected')
}

describe('PNG header', () => {
  it('reads the dimensions of a valid PNG', () => {
    const header = readPngHeader(solidPng(37, 19, MAGENTA))
    expect(header.width).toBe(37)
    expect(header.height).toBe(19)
    expect(header.bitDepth).toBe(8)
    expect(header.colorType).toBe(2)
    expect(header.channels).toBe(3)
  })

  it('rejects a file that is not a PNG', () => {
    expect(() => readPngHeader(Buffer.from('not a png at all, not even close'))).toThrow(/too short|signature/i)
  })

  it('rejects a broken signature', () => {
    const error = expectInvalid(breakSignature(solidPng(4, 4, MAGENTA)))
    expect(error.message).toMatch(/signature/i)
  })

  it('rejects a corrupt IHDR CRC', () => {
    const error = expectInvalid(corruptHeaderCrc(solidPng(4, 4, MAGENTA)))
    expect(error.message).toMatch(/CRC/i)
  })

  it('rejects a zero-sized image', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(0, 0)
    header.writeUInt32BE(10, 4)
    header[8] = 8
    header[9] = 2
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk('IHDR', header),
      pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    expectInvalid(png)
  })

  it('rejects a bit depth other than 8', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(4, 0)
    header.writeUInt32BE(4, 4)
    header[8] = 16
    header[9] = 2
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk('IHDR', header),
      pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(/bit depth/i)
  })

  it('rejects an interlaced PNG explicitly', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(2, 4)
    header[8] = 8
    header[9] = 2
    header[12] = 1
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk('IHDR', header),
      pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(/interlaced/i)
  })

  it('rejects a truncated file', () => {
    expectInvalid(truncatePng(solidPng(64, 64, MAGENTA)))
  })

  it('rejects a missing IDAT chunk', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk(
        'IHDR',
        (() => {
          const header = Buffer.alloc(13)
          header.writeUInt32BE(4, 0)
          header.writeUInt32BE(4, 4)
          header[8] = 8
          header[9] = 2
          return header
        })(),
      ),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(/IDAT|image data/i)
  })
})

describe('PNG decoding', () => {
  it('decodes every standard row filter to identical pixels', () => {
    for (const filter of [0, 1, 2, 3, 4] as const) {
      const png = makePng({
        width: 11,
        height: 7,
        filter,
        pixel: (x, y) => [x * 20, y * 30, (x * y) % 256],
      })
      const decoded = decodePng(png)
      expect(decoded.width).toBe(11)
      expect(decoded.height).toBe(7)
      expect(pixelAt(decoded, 0, 0)).toEqual({ r: 0, g: 0, b: 0 })
      expect(pixelAt(decoded, 5, 3)).toEqual({ r: 100, g: 90, b: 15 })
      expect(pixelAt(decoded, 10, 6)).toEqual({ r: 200, g: 180, b: 60 })
    }
  })

  it('decodes an RGBA image and composites transparent pixels over white', () => {
    const png = makePng({
      width: 2,
      height: 1,
      colorType: 6,
      pixel: (x) => (x === 0 ? [0, 0, 0, 0] : [10, 20, 30, 128]),
    })
    const decoded = decodePng(png)
    expect(decoded.channels).toBe(4)
    expect(pixelAt(decoded, 0, 0)).toEqual({ r: 255, g: 255, b: 255 })
    expect(pixelAt(decoded, 1, 0)).toEqual({ r: 132, g: 137, b: 142 })
  })

  it('decodes a greyscale image', () => {
    const png = makePng({ width: 3, height: 1, colorType: 0, pixel: (x) => [x * 40] })
    const decoded = decodePng(png)
    expect(decoded.channels).toBe(1)
    expect(pixelAt(decoded, 2, 0)).toEqual({ r: 80, g: 80, b: 80 })
  })

  it('decodes a palette image into RGB', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(1, 4)
    header[8] = 8
    header[9] = 3
    const palette = Buffer.from([255, 0, 255, 0, 255, 0])
    const rows = Buffer.concat([Buffer.from([0]), Buffer.from([0, 1])])
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk('IHDR', header),
      pngChunk('PLTE', palette),
      pngChunk('IDAT', zlib.deflateSync(rows)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    const decoded = decodePng(png)
    expect(decoded.channels).toBe(3)
    expect(pixelAt(decoded, 0, 0)).toEqual(MAGENTA)
    expect(pixelAt(decoded, 1, 0)).toEqual({ r: 0, g: 255, b: 0 })
  })

  it('rejects an indexed PNG without a palette', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0)
    header.writeUInt32BE(1, 4)
    header[8] = 8
    header[9] = 3
    const png = Buffer.concat([
      PNG_SIGNATURE_BYTES,
      pngChunk('IHDR', header),
      pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(/palette/i)
  })
})

describe('image statistics', () => {
  it('flags a single-colour image as uniform', () => {
    const stats = analyzeImage(decodePng(solidPng(120, 80, BLACK)))
    expect(stats.uniform).toBe(true)
    expect(stats.sampledColors).toBe(1)
    expect(stats.dominantColor).toEqual(BLACK)
    expect(stats.dominantShare).toBe(1)
    expect(stats.meanLuminance).toBe(0)
    expect(stats.luminanceStdDev).toBe(0)
  })

  it('treats a fully transparent image as uniform white, which is the blank signature', () => {
    const png = makePng({ width: 16, height: 16, colorType: 6, pixel: () => [0, 0, 0, 0] })
    const stats = analyzeImage(decodePng(png))
    expect(stats.uniform).toBe(true)
    expect(stats.dominantColor).toEqual(WHITE)
  })

  it('does not flag a two-colour image as uniform', () => {
    const stats = analyzeImage(decodePng(splitPng(100, 40, MAGENTA, BLACK)))
    expect(stats.uniform).toBe(false)
    expect(stats.sampledColors).toBe(2)
    expect(stats.luminanceStdDev).toBeGreaterThan(0)
  })

  it('reports the dominant colour and its share', () => {
    // 75% magenta, 25% black
    const png = makePng({
      width: 100,
      height: 10,
      pixel: (x) => (x < 75 ? [255, 0, 255] : [0, 0, 0]),
    })
    const stats = analyzeImage(decodePng(png))
    expect(stats.dominantColor).toEqual(MAGENTA)
    expect(stats.dominantShare).toBeGreaterThan(0.7)
    expect(stats.dominantShare).toBeLessThan(0.8)
  })

  it('measures how much of an image matches a colour', () => {
    const image = decodePng(splitPng(200, 50, MAGENTA, BLACK))
    expect(colorShare(image, MAGENTA)).toBeGreaterThan(0.45)
    expect(colorShare(image, MAGENTA)).toBeLessThan(0.55)
    expect(colorShare(image, { r: 0, g: 255, b: 0 })).toBe(0)
    expect(colorShare(image, { r: 254, g: 1, b: 250 }, { tolerance: 8 })).toBeGreaterThan(0.4)
  })
})
