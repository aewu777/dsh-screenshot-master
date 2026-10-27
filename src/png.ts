/**
 * Minimal PNG decoder used to verify that a capture really is a usable image.
 *
 * Rationale: a capture can "succeed" at the operating-system level and still be
 * a zero-byte file, a truncated stream, or a uniformly black frame (which is
 * what a failed `PrintWindow` on a hardware-accelerated window looks like). The
 * plugin therefore decodes every PNG it produces and inspects the pixels.
 *
 * Supported subset: non-interlaced, bit depth 8, colour types 0/2/3/4/6.
 * That covers every PNG produced by System.Drawing, ScreenCaptureKit, ImageIO
 * and the macOS `screencapture` utility. Anything else is rejected explicitly
 * instead of being silently accepted.
 */

import zlib from 'node:zlib'
import { ScreenshotError } from './errors.js'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const COLOR_TYPES: Record<number, number> = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // indexed
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
}

export interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
  channels: number
  compression: number
  filter: number
  interlace: number
}

export interface DecodedPng extends PngHeader {
  /** Row-major, unfiltered samples: `channels` bytes per pixel. */
  data: Buffer
}

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    const index = (crc ^ buffer[i]!) & 0xff
    crc = (CRC_TABLE[index]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

function invalid(message: string, details?: Record<string, unknown>): ScreenshotError {
  return new ScreenshotError('INVALID_PNG', message, {
    hint: 'The capture did not produce a decodable PNG; retry or choose another capture target.',
    ...(details ? { details } : {}),
  })
}

/** Read and validate the PNG signature and IHDR without decoding pixel data. */
export function readPngHeader(buffer: Buffer): PngHeader {
  if (buffer.length < 33) {
    throw invalid(`PNG is too short to contain a header (${buffer.length} bytes).`)
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalid('File does not start with the PNG signature.')
  }

  const length = buffer.readUInt32BE(8)
  const type = buffer.subarray(12, 16).toString('latin1')
  if (type !== 'IHDR' || length !== 13) {
    throw invalid(`First PNG chunk is ${JSON.stringify(type)} instead of IHDR.`)
  }

  const chunkData = buffer.subarray(16, 29)
  const expectedCrc = buffer.readUInt32BE(29)
  const actualCrc = crc32(buffer.subarray(12, 29))
  if (expectedCrc !== actualCrc) {
    throw invalid('PNG IHDR chunk failed its CRC check.')
  }

  const width = chunkData.readUInt32BE(0)
  const height = chunkData.readUInt32BE(4)
  const bitDepth = chunkData[8]!
  const colorType = chunkData[9]!
  const compression = chunkData[10]!
  const filter = chunkData[11]!
  const interlace = chunkData[12]!

  if (width === 0 || height === 0) {
    throw invalid(`PNG reports an empty image (${width}x${height}).`)
  }
  const channels = COLOR_TYPES[colorType]
  if (channels === undefined) {
    throw invalid(`Unsupported PNG colour type ${colorType}.`)
  }
  if (bitDepth !== 8) {
    throw invalid(`Unsupported PNG bit depth ${bitDepth}; only 8-bit images are accepted.`)
  }
  if (compression !== 0 || filter !== 0) {
    throw invalid('Unsupported PNG compression or filter method.')
  }

  return { width, height, bitDepth, colorType, channels, compression, filter, interlace }
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

function unfilter(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer {
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let rawOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset]!
    rawOffset += 1
    const rowStart = y * stride
    const previousStart = (y - 1) * stride

    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset + x]!
      const left = x >= channels ? out[rowStart + x - channels]! : 0
      const up = y > 0 ? out[previousStart + x]! : 0
      const upLeft = y > 0 && x >= channels ? out[previousStart + x - channels]! : 0

      let reconstructed: number
      switch (filterType) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + up
          break
        case 3:
          reconstructed = value + ((left + up) >> 1)
          break
        case 4:
          reconstructed = value + paeth(left, up, upLeft)
          break
        default:
          throw invalid(`Unsupported PNG row filter type ${filterType}.`)
      }
      out[rowStart + x] = reconstructed & 0xff
    }
    rawOffset += stride
  }

  return out
}

function readChunks(buffer: Buffer): { idat: Buffer[]; palette: Buffer | undefined; header: PngHeader } {
  let offset = 8
  const idat: Buffer[] = []
  let palette: Buffer | undefined
  let header: PngHeader | undefined

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) {
      throw invalid(`PNG chunk ${JSON.stringify(type)} is truncated.`)
    }
    const data = buffer.subarray(dataStart, dataEnd)
    const expectedCrc = buffer.readUInt32BE(dataEnd)
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd))
    if (expectedCrc !== actualCrc) {
      throw invalid(`PNG chunk ${JSON.stringify(type)} failed its CRC check.`)
    }

    if (type === 'IHDR') {
      header = readPngHeader(buffer)
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  if (!header) throw invalid('PNG has no IHDR chunk.')
  if (idat.length === 0) throw invalid('PNG has no image data (IDAT) chunk.')

  return { idat, palette, header }
}

/** Fully decode a PNG buffer into raw 8-bit samples. */
export function decodePng(buffer: Buffer): DecodedPng {
  const { idat, palette, header } = readChunks(buffer)

  if (header.interlace !== 0) {
    throw invalid('Interlaced PNG files are not supported.')
  }
  if (header.colorType === 3 && !palette) {
    throw invalid('Indexed PNG is missing its PLTE palette chunk.')
  }

  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch (error) {
    throw invalid('PNG image data is not a valid zlib stream.', { cause: error });
  }

  const expected = header.height * (header.width * header.channels + 1)
  if (raw.length < expected) {
    throw invalid(`PNG image data is truncated: expected ${expected} bytes, got ${raw.length}.`)
  }

  let pixels = unfilter(raw, header.width, header.height, header.channels)

  if (header.colorType === 3) {
    const entries = Math.floor(palette!.length / 3)
    const expanded = Buffer.alloc(header.width * header.height * 3)
    for (let i = 0; i < header.width * header.height; i += 1) {
      const index = pixels[i]!
      if (index >= entries) {
        throw invalid(`Indexed PNG references palette entry ${index} of ${entries}.`)
      }
      expanded[i * 3] = palette![index * 3]!
      expanded[i * 3 + 1] = palette![index * 3 + 1]!
      expanded[i * 3 + 2] = palette![index * 3 + 2]!
    }
    pixels = expanded
    return { ...header, channels: 3, data: pixels }
  }

  return { ...header, data: pixels }
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface ImageStatistics {
  width: number
  height: number
  /** True when every pixel is exactly the same colour. */
  uniform: boolean
  /** Number of distinct colours seen in the sample, capped by `maxSample`. */
  sampledColors: number
  /** Most frequent sampled colour, or `null` for an empty image. */
  dominantColor: Rgb | null
  /** Share of sampled pixels that carry the dominant colour, 0..1. */
  dominantShare: number
  /** Mean Rec.709 luma of the sampled pixels, 0..255. */
  meanLuminance: number
  /** Standard deviation of the sampled luma, 0..255. */
  luminanceStdDev: number
}

function pixelOffset(index: number, channels: number): number {
  return index * channels
}

/**
 * Read one pixel as RGB, compositing any alpha over white so that a transparent
 * region is distinguishable from a black one.
 */
export function pixelAt(image: DecodedPng, x: number, y: number): Rgb {
  const { channels, data, width } = image
  const index = y * width + x
  const offset = pixelOffset(index, channels)
  let r: number
  let g: number
  let b: number
  let a = 255

  if (channels === 1) {
    r = data[offset]!
    g = r
    b = r
  } else if (channels === 2) {
    r = data[offset]!
    g = r
    b = r
    a = data[offset + 1]!
  } else {
    r = data[offset]!
    g = data[offset + 1]!
    b = data[offset + 2]!
    if (channels === 4) a = data[offset + 3]!
  }

  if (a === 255) return { r, g, b }
  const blend = (channel: number): number => Math.round((channel * a + 255 * (255 - a)) / 255)
  return { r: blend(r), g: blend(g), b: blend(b) }
}

/**
 * Summarise an image.
 *
 * `maxSample` bounds the work: statistics use a stride-sampled subset, while
 * `uniform` is decided by an exact full scan because a uniform frame is the
 * signature of a failed capture.
 */
export function analyzeImage(image: DecodedPng, options: { maxSample?: number } = {}): ImageStatistics {
  const { width, height } = image
  const total = width * height
  const maxSample = Math.max(1, options.maxSample ?? 65_536)

  if (total === 0) {
    return {
      width,
      height,
      uniform: true,
      sampledColors: 0,
      dominantColor: null,
      dominantShare: 0,
      meanLuminance: 0,
      luminanceStdDev: 0,
    }
  }

  const first = pixelAt(image, 0, 0)
  let uniform = true
  for (let i = 1; i < total; i += 1) {
    const x = i % width
    const y = (i - x) / width
    const candidate = pixelAt(image, x, y)
    if (candidate.r !== first.r || candidate.g !== first.g || candidate.b !== first.b) {
      uniform = false
      break
    }
  }

  const stride = Math.max(1, Math.floor(total / maxSample))
  const counts = new Map<number, number>()
  let samples = 0
  let lumSum = 0
  let lumSquareSum = 0

  for (let i = 0; i < total; i += stride) {
    const x = i % width
    const y = (i - x) / width
    const { r, g, b } = pixelAt(image, x, y)
    const key = (r << 16) | (g << 8) | b
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    lumSum += luminance
    lumSquareSum += luminance * luminance
    samples += 1
  }

  let dominantKey = 0
  let dominantCount = 0
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominantKey = key
      dominantCount = count
    }
  }

  const meanLuminance = samples === 0 ? 0 : lumSum / samples
  const variance = samples === 0 ? 0 : Math.max(0, lumSquareSum / samples - meanLuminance * meanLuminance)

  return {
    width,
    height,
    uniform,
    sampledColors: counts.size,
    dominantColor: {
      r: (dominantKey >> 16) & 0xff,
      g: (dominantKey >> 8) & 0xff,
      b: dominantKey & 0xff,
    },
    dominantShare: samples === 0 ? 0 : dominantCount / samples,
    meanLuminance,
    luminanceStdDev: Math.sqrt(variance),
  }
}

/** Share of sampled pixels within `tolerance` of the requested colour. */
export function colorShare(
  image: DecodedPng,
  target: Rgb,
  options: { tolerance?: number; maxSample?: number } = {},
): number {
  const { width, height } = image
  const total = width * height
  if (total === 0) return 0
  const tolerance = options.tolerance ?? 12
  const maxSample = Math.max(1, options.maxSample ?? 65_536)
  const stride = Math.max(1, Math.floor(total / maxSample))

  let matches = 0
  let samples = 0
  for (let i = 0; i < total; i += stride) {
    const x = i % width
    const y = (i - x) / width
    const pixel = pixelAt(image, x, y)
    if (
      Math.abs(pixel.r - target.r) <= tolerance &&
      Math.abs(pixel.g - target.g) <= tolerance &&
      Math.abs(pixel.b - target.b) <= tolerance
    ) {
      matches += 1
    }
    samples += 1
  }
  return samples === 0 ? 0 : matches / samples
}
