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
