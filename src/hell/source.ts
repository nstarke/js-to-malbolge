import { fillerValue } from "./cycles.js";

/** Sparse while placing, byte-backed while emitting large source images. */
export class SourceCells {
  private readonly pages = new Map<number, Uint8Array>();
  last = -1;
  set(address: number, value: number): void {
    const page = Math.floor(address / 32768);
    let data = this.pages.get(page);
    if (!data) { data = new Uint8Array(32768); this.pages.set(page, data); }
    data[address % 32768] = value;
    this.last = Math.max(this.last, address);
  }
  get(address: number): number | undefined {
    return this.pages.get(Math.floor(address / 32768))?.[address % 32768] || undefined;
  }
  image(): Uint8Array {
    const image = new Uint8Array(this.last + 1);
    for (const [page, data] of this.pages) {
      const start = page * 32768;
      image.set(data.subarray(0, Math.min(data.length, image.length - start)), start);
    }
    for (let i = 0; i < image.length; i++) if (!image[i]) image[i] = fillerValue(i);
    return image;
  }
}

export function sourceString(image: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < image.length; i += 32768) parts.push(String.fromCharCode(...image.subarray(i, i + 32768)));
  return parts.join("");
}
