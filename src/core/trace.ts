/**
 * Deterministic execution traces (S4). Because the language is pure, a trace of
 * basic-block indices is a complete description of an execution: equal hash means
 * equal behaviour, which is what the determinism tests compare.
 */
import type { TrapKind } from './vm';

export interface TraceRecord {
  /** fnIndex * 65536 + blockIndex, kept as one number so hashing is order-exact. */
  readonly entries: number[];
  trap?: TrapKind;
  value?: number;
}

export class TraceRecorder {
  readonly entries: number[] = [];
  trap: TrapKind | undefined;
  value: number | undefined;

  /** Bind to `RunOptions.onBlock`. */
  readonly onBlock = (fnIndex: number, blockIndex: number): void => {
    this.entries.push(fnIndex * 65536 + blockIndex);
  };

  size(): number {
    return this.entries.length;
  }

  /** FNV-1a over the block stream plus the outcome. Stable across runs and engines. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (n: number): void => {
      h ^= n & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (n >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (n >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (n >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };

    for (const e of this.entries) mix(e);
    mix(this.trap === undefined ? 0xfeed : 0xbeef);
    if (this.trap !== undefined) {
      for (let i = 0; i < this.trap.length; i++) mix(this.trap.charCodeAt(i));
    }
    mix(this.value === undefined ? 0 : Math.trunc(this.value) & 0xffffffff);
    return h.toString(16).padStart(8, '0');
  }

  toJSON(): TraceRecord {
    const out: TraceRecord = { entries: this.entries };
    if (this.trap !== undefined) out.trap = this.trap;
    if (this.value !== undefined) out.value = this.value;
    return out;
  }
}
