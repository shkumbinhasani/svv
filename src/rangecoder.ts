const TOP = 0x1000000
const PROB_ONE = 2048
const PROB_HALF = 1024
const ADAPT = 4
const MAX_BITS = 40

class Contexts {
  readonly probs: Uint16Array
  constructor(size: number) {
    this.probs = new Uint16Array(size).fill(PROB_HALF)
  }
}

class IntContexts {
  readonly prefix = new Contexts(MAX_BITS + 1)
  readonly suffix = new Contexts((MAX_BITS + 1) * 3)
  readonly zero = new Contexts(1)
  readonly sign = new Contexts(1)
}

class SymbolContexts {
  readonly tree: Contexts
  constructor(readonly bits: number) {
    this.tree = new Contexts(1 << bits)
  }
}

class ContextStore {
  private bits = new Map<string, Contexts>()
  private ints = new Map<string, IntContexts>()
  private symbols = new Map<string, SymbolContexts>()

  bit(key: string): Contexts {
    let c = this.bits.get(key)
    if (!c) this.bits.set(key, (c = new Contexts(1)))
    return c
  }

  int(key: string): IntContexts {
    let c = this.ints.get(key)
    if (!c) this.ints.set(key, (c = new IntContexts()))
    return c
  }

  symbol(key: string, bits: number): SymbolContexts {
    let c = this.symbols.get(key)
    if (!c) this.symbols.set(key, (c = new SymbolContexts(bits)))
    return c
  }
}

function bitLength(n: number): number {
  let bits = 0
  while (n >= 1) {
    n = Math.floor(n / 2)
    bits++
  }
  return bits
}

export class BitWriter {
  private low = 0
  private range = 0xffffffff
  private cache = 0
  private cacheSize = 1
  private out: number[] = []
  private store = new ContextStore()

  private encode(probs: Uint16Array, i: number, bit: number) {
    const p = probs[i]!
    const bound = (this.range >>> 11) * p
    if (bit === 0) {
      this.range = bound
      probs[i] = p + ((PROB_ONE - p) >> ADAPT)
    } else {
      this.low += bound
      this.range -= bound
      probs[i] = p - (p >> ADAPT)
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0
      this.shiftLow()
    }
  }

  private encodeDirect(bit: number) {
    this.range = this.range >>> 1
    if (bit) this.low += this.range
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0
      this.shiftLow()
    }
  }

  private shiftLow() {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0
      let temp = this.cache
      do {
        this.out.push((temp + carry) & 0xff)
        temp = 0xff
      } while (--this.cacheSize !== 0)
      this.cache = Math.floor(this.low / TOP) & 0xff
    }
    this.cacheSize++
    this.low = (this.low % TOP) * 256
  }

  bit(key: string, value: boolean): void {
    this.encode(this.store.bit(key).probs, 0, value ? 1 : 0)
  }

  uint(key: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`uint ${key}: ${value}`)
    this.encodeUint(this.store.int(key), value)
  }

  sint(key: string, value: number): void {
    if (!Number.isInteger(value)) throw new RangeError(`sint ${key}: ${value}`)
    const c = this.store.int(key)
    this.encode(c.zero.probs, 0, value === 0 ? 0 : 1)
    if (value === 0) return
    this.encode(c.sign.probs, 0, value < 0 ? 1 : 0)
    this.encodeUint(c, Math.abs(value) - 1)
  }

  symbol(key: string, value: number, bits: number): void {
    if (!Number.isInteger(value) || value < 0 || value >= 1 << bits) throw new RangeError(`symbol ${key}: ${value}`)
    const probs = this.store.symbol(key, bits).tree.probs
    let node = 1
    for (let i = bits - 1; i >= 0; i--) {
      const b = (value >> i) & 1
      this.encode(probs, node, b)
      node = (node << 1) | b
    }
  }

  raw(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) this.encodeDirect(Math.floor(value / 2 ** i) % 2)
  }

  private encodeUint(c: IntContexts, value: number) {
    const v = value + 1
    const n = bitLength(v) - 1
    if (n > MAX_BITS - 1) throw new RangeError(`integer too large: ${value}`)
    for (let i = 0; i < n; i++) this.encode(c.prefix.probs, i, 1)
    this.encode(c.prefix.probs, n, 0)
    for (let i = n - 1; i >= 0; i--) {
      const b = Math.floor(v / 2 ** i) % 2
      const pos = n - 1 - i
      if (pos < 2) this.encode(c.suffix.probs, n * 3 + pos, b)
      else this.encodeDirect(b)
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow()
    let end = this.out.length
    while (end > 1 && this.out[end - 1] === 0) end--
    return Uint8Array.from(this.out.slice(1, end))
  }
}

export class BitReader {
  private range = 0xffffffff
  private code = 0
  private pos: number
  private store = new ContextStore()

  constructor(private buf: Uint8Array, offset = 0) {
    this.pos = offset
    for (let i = 0; i < 4; i++) this.code = (this.code * 256 + this.next()) >>> 0
  }

  private next(): number {
    if (this.pos < this.buf.length) return this.buf[this.pos++]!
    if (++this.pos > this.buf.length + 8) throw new RangeError('truncated SVV data')
    return 0
  }

  private decode(probs: Uint16Array, i: number): number {
    const p = probs[i]!
    const bound = (this.range >>> 11) * p
    let bit: number
    if (this.code < bound) {
      this.range = bound
      probs[i] = p + ((PROB_ONE - p) >> ADAPT)
      bit = 0
    } else {
      this.code -= bound
      this.range -= bound
      probs[i] = p - (p >> ADAPT)
      bit = 1
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0
      this.code = (this.code * 256 + this.next()) >>> 0
    }
    return bit
  }

  private decodeDirect(): number {
    this.range = this.range >>> 1
    let bit = 0
    if (this.code >= this.range) {
      this.code -= this.range
      bit = 1
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0
      this.code = (this.code * 256 + this.next()) >>> 0
    }
    return bit
  }

  get overrun(): boolean {
    return this.pos > this.buf.length + 4
  }

  count(key: string, max = 1 << 22): number {
    const n = this.uint(key)
    if (n > max) throw new RangeError(`corrupt SVV data: ${key} count ${n}`)
    return n
  }

  bit(key: string): boolean {
    return this.decode(this.store.bit(key).probs, 0) === 1
  }

  uint(key: string): number {
    return this.decodeUint(this.store.int(key))
  }

  sint(key: string): number {
    const c = this.store.int(key)
    if (this.decode(c.zero.probs, 0) === 0) return 0
    const negative = this.decode(c.sign.probs, 0) === 1
    const magnitude = this.decodeUint(c) + 1
    return negative ? -magnitude : magnitude
  }

  symbol(key: string, bits: number): number {
    const probs = this.store.symbol(key, bits).tree.probs
    let node = 1
    for (let i = 0; i < bits; i++) node = (node << 1) | this.decode(probs, node)
    return node - (1 << bits)
  }

  raw(bits: number): number {
    let v = 0
    for (let i = 0; i < bits; i++) v = v * 2 + this.decodeDirect()
    return v
  }

  private decodeUint(c: IntContexts): number {
    let n = 0
    while (this.decode(c.prefix.probs, n) === 1) {
      n++
      if (n >= MAX_BITS) throw new RangeError('corrupt integer')
    }
    let v = 1
    for (let pos = 0; pos < n; pos++) {
      const b = pos < 2 ? this.decode(c.suffix.probs, n * 3 + pos) : this.decodeDirect()
      v = v * 2 + b
    }
    return v - 1
  }
}
