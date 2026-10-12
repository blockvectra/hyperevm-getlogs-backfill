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
