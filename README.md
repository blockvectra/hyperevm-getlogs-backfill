# HyperEVM `eth_getLogs`: block range limits and a 30-day backfill model

A 30-day HyperEVM backfill is about **2,592 calls at 1,000 blocks per call**; at the documented 10- and 50-block windows, the same modeled interval takes **259,200** and **51,840 calls**, respectively. [BlockVectra's live chain catalog](https://api.blockvectra.com/v1/chains) lists `hyperevm_mainnet.max_logs_block_range` as 1,000; the comparison limits and their official sources were checked on **2026-10-12** (Alchemy [eth_getLogs documentation](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs); Chainstack [Hyperliquid EVM eth_getLogs documentation](https://docs.chainstack.com/reference/hyperliquid-evm-eth-get-logs)).

## Why a wide query fails

`eth_getLogs` accepts an inclusive block interval. Its span is `toBlock − fromBlock + 1`, so a request is too wide when that value exceeds the chain's published `max_logs_block_range`. On BlockVectra, the response is HTTP 200 with JSON-RPC code `-32602` and reason `logs_range_too_large`; the request is not retryable. Read the current per-chain limit from [`GET /v1/chains`](https://api.blockvectra.com/v1/chains) rather than assuming every network has the same range. [BlockVectra's range guide](https://docs.blockvectra.com/en/guides/getlogs-block-range/?ref=article-hyperevm-getlogs) documents the error and limit.

## Split the interval

For current cursor `from`, limit `L`, and final block `end`, set `to = min(from + L − 1, end)`. Query `[from, to]`; only after success, continue at `to + 1`. This counts both endpoints, avoids gaps and overlaps, and leaves a failed chunk available to resume. The HyperEVM limit is 1,000 blocks per authenticated request; its keyless public endpoint does not expose `eth_getLogs`. [The live chain catalog](https://api.blockvectra.com/v1/chains) and [HyperEVM backfill guide](https://docs.blockvectra.com/en/guides/hyperevm-backfill/?ref=article-hyperevm-getlogs) provide these endpoint details.

## How many calls for 30 days?

Using a planning assumption based on HyperEVM's dual-layer block structure—small blocks approximately every 1 second, large blocks approximately every 1 minute (30 M gas)—the block number advances at roughly one increment per second (measured at 0.98 seconds per block on 2026-10-10; source: QuickNode's [HyperEVM reference](https://www.quicknode.com/docs/hyperliquid/eth_bigBlockGasPrice)), so 30 days is `30 × 86,400 = 2,592,000` blocks. This is an estimate of query count, not a measured guarantee that a provider retains or serves every block in that history. Assuming one contract, no retries, and no result-size or response limit is hit:

- **BlockVectra, 1,000 blocks:** `ceil(2,592,000 / 1,000) = 2,592` calls.
- **Alchemy Free, 10 blocks:** `ceil(2,592,000 / 10) = 259,200` calls. Alchemy's official [eth_getLogs page](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs) documents the Free-tier range; verified 2026-10-12.
- **Chainstack, 50 blocks:** `ceil(2,592,000 / 50) = 51,840` calls. Chainstack's official [Hyperliquid EVM eth_getLogs page](https://docs.chainstack.com/reference/hyperliquid-evm-eth-get-logs) documents the Hyperliquid range; verified 2026-10-12.

The 1,000-block value comes from BlockVectra's live [`/v1/chains`](https://api.blockvectra.com/v1/chains) response. The block-number planning assumption is based on HyperEVM's dual-layer structure (small blocks ~1 s, large blocks ~1 min), with a measured block-number advance rate of 0.98 seconds per block on 2026-10-10. The competitor limits and resulting call counts are documented above with their official sources and check dates. Call counts compare request counts only; they do not compare historical coverage, response limits, pricing, or service guarantees. The comparison above reflects free-tier block windows only; Alchemy's paid tiers have no block-range limit on HyperEVM, and 1,000 blocks is not the largest window across all tiers and providers.

## Run sequential chunks with TypeScript

This is the HyperEVM adaptation of the existing [block-range guide example](https://docs.blockvectra.com/en/guides/getlogs-block-range/?ref=article-hyperevm-getlogs). It reads the live range and checks that the method is allowed, then prints each completed chunk. Use Node.js 24 or later, set a key and contract address, and provide a confirmed finite interval.

Save as `backfill.mjs` and run with Node 20+.

```js
const { BLOCKVECTRA_API_KEY: key, LOG_ADDRESS: address, FROM_BLOCK, TO_BLOCK } = process.env;
if (!key || !/^0x[0-9a-f]{40}$/i.test(address ?? '')) throw new Error('Set BLOCKVECTRA_API_KEY and LOG_ADDRESS');
if (![FROM_BLOCK, TO_BLOCK].every(value => /^(0x[0-9a-f]+|[0-9]+)$/i.test(value ?? ''))) {
  throw new Error('Set FROM_BLOCK and TO_BLOCK to nonnegative block numbers');
}
const start = BigInt(FROM_BLOCK), end = BigInt(TO_BLOCK);
if (start > end) throw new Error('FROM_BLOCK must not exceed TO_BLOCK');
const chainSlug = 'hyperevm_mainnet';
const chainsUrl = 'https://api.blockvectra.com/v1/chains';
const catalogResponse = await fetch(chainsUrl, { signal: AbortSignal.timeout(15_000) });
if (!catalogResponse.ok) throw new Error(`Chains HTTP ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const chain = catalog.chains.find(item => item.chain === chainSlug);
if (!chain || !Number.isSafeInteger(chain.max_logs_block_range) || chain.max_logs_block_range <= 0) {
  throw new Error('Missing or invalid max_logs_block_range');
}
const matches = pattern => pattern.endsWith('*') ? 'eth_getLogs'.startsWith(pattern.slice(0, -1)) : pattern === 'eth_getLogs';
if (!chain.methods?.allow?.some(matches) || chain.methods?.deny?.some(matches)) {
  throw new Error('eth_getLogs is unavailable on this chain');
}
const max = BigInt(chain.max_logs_block_range);
const rpcUrl = new URL('./hyperevm_mainnet', chainsUrl).href;
const hex = value => `0x${value.toString(16)}`;
for (let from = start; from <= end;) {
  const to = from + max - 1n < end ? from + max - 1n : end;
  const response = await fetch(rpcUrl, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{ address, fromBlock: hex(from), toBlock: hex(to) }] }),
  });
  const body = await response.json();
  if (!response.ok || body.error || !Array.isArray(body.result)) {
    throw new Error(`RPC HTTP ${response.status}: ${JSON.stringify(body.error ?? 'Invalid result')}`);
  }
  console.log(JSON.stringify({ fromBlock: hex(from), toBlock: hex(to), result: body.result }));
  from = to + 1n;
}
```

Each output line represents a successful chunk. A failed HTTP or JSON-RPC response stops the run before the cursor advances. Check the earliest interval you need before treating the result as a complete historical backfill.

*The author is from BlockVectra. See the [HyperEVM backfill guide](https://docs.blockvectra.com/en/guides/hyperevm-backfill/?ref=article-hyperevm-getlogs).*

---

## Files

- `backfill.mjs`: the script above. Requires Node 20+ and a BlockVectra API key in `BLOCKVECTRA_API_KEY`.

## License

MIT
