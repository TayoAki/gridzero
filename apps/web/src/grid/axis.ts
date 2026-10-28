// Row or column geometry with a default size and sparse overrides.
// Offsets are logical pixels from the start of the axis. With 1M rows the total
// height (~22M px) exceeds what browsers allow for a native scroll container,
// so the grid scrolls in logical space and never sizes a DOM element to it.

export class SparseAxis {
  private keys: number[] = [];
  private sizes: number[] = [];
  // prefixDelta[k] = sum of (sizes[j] - defaultSize) for j < k
  private prefixDelta: number[] = [0];

  constructor(readonly count: number, readonly defaultSize: number) {}

  setSize(index: number, size: number): void {
    const k = lowerBound(this.keys, index);
    if (this.keys[k] === index) {
      this.sizes[k] = size;
    } else {
      this.keys.splice(k, 0, index);
      this.sizes.splice(k, 0, size);
    }
    this.prefixDelta = [0];
    for (let j = 0; j < this.keys.length; j++) {
      this.prefixDelta.push(this.prefixDelta[j] + this.sizes[j] - this.defaultSize);
    }
  }

  sizeOf(index: number): number {
    const k = lowerBound(this.keys, index);
    return this.keys[k] === index ? this.sizes[k] : this.defaultSize;
  }

  offsetOf(index: number): number {
    return index * this.defaultSize + this.prefixDelta[lowerBound(this.keys, index)];
  }

  total(): number {
    return this.offsetOf(this.count);
  }

  /** Largest index whose start offset is <= px, clamped to [0, count - 1]. */
  indexAt(px: number): number {
    if (px <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.offsetOf(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
