export const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql'

/**
 * Minimal POST wrapper around Sui's GraphQL RPC. Throws on both transport
 * errors and GraphQL-level errors so callers don't have to check json.errors
 * themselves everywhere.
 */
export async function graphqlQuery(query, variables = {}) {
  const res = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  })

  const json = await res.json()

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`)
  }

  return json.data
}

/**
 * Retries a failing async call with exponential backoff. Added after a real
 * reconstruction run silently dropped two NAVI positions for one snapshot day
 * - a transient failure (rate limit/timeout, never actually confirmed which)
 * was caught and treated identically to "this wallet has no position here",
 * producing a wrong-but-plausible-looking snapshot with no visible error.
 * That failure mode is worse than the run just crashing, so callers that hit
 * this should let a final failure propagate rather than swallow it.
 */
export async function withRetries(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries) break
      const delay = baseDelayMs * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastErr
}

/**
 * Same coin-metadata lookup index.js already does for the live report, kept
 * here so the reconstruction path can reuse it without re-fetching decimals
 * per snapshot day (metadata for a given coinType doesn't change over time).
 */
const coinMetadataCache = new Map()

export async function fetchCoinMetadata(coinType) {
  if (coinMetadataCache.has(coinType)) {
    return coinMetadataCache.get(coinType)
  }

  const data = await graphqlQuery(
    `
      query CoinMeta($type: String!) {
        coinMetadata(coinType: $type) {
          decimals
          symbol
          name
        }
      }
    `,
    { type: coinType }
  )

  const metadata = data.coinMetadata ?? null
  coinMetadataCache.set(coinType, metadata)

  return metadata
}
