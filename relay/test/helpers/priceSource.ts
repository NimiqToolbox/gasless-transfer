import type { PriceReading, PriceSource } from '../../src/fees/priceSource.js';
import type { RelayMetrics } from '../../src/metrics.js';
import { parseFixed } from '../../src/util/bigint.js';

/** Deterministic price fixture; never included in the production relay. */
export class TestPriceSource implements PriceSource {
    readonly feed = null;
    private readonly reading: PriceReading;
    constructor(price: string, private readonly metrics?: RelayMetrics) {
        const value = parseFixed(price, 8);
        if (value === undefined) throw new Error('Invalid test price');
        this.reading = { value, decimals: 8, source: 'chainlink', updatedAt: null, reason: null };
    }
    async get(): Promise<PriceReading> {
        this.metrics?.priceSource.set({ source: 'chainlink' }, 1);
        this.metrics?.polUsd.set(Number(this.reading.value) / 1e8);
        return this.reading;
    }
    last(): PriceReading { return this.reading; }
}
