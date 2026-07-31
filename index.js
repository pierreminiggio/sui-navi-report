import { getLendingState, getHealthFactor } from '@naviprotocol/lending'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'

const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql'

// NOTE on the JSON-RPC deprecation bug: earlier versions of @naviprotocol/lending
// (<=1.4.6) defaulted to a SuiClient pointed at a public JSON-RPC full node, which
// Sui retired the week of July 27, 2026 (-32601 Method not found). @naviprotocol/
// lending@2.0.8 fixes this upstream -- its own default client is now a SuiGrpcClient
// against https://fullnode.mainnet.sui.io:443 (verified by reading its source: see
// node_modules/@naviprotocol/lending/dist/sui.js). So as long as this package stays
// on ^2.0.0+, no custom client needs to be constructed here at all.

// --- Step 1: fetch raw coin balances owned by the wallet ---
export async function fetchWalletBalances(owner) {
  const query = `
    query WalletHoldings($owner: SuiAddress!) {
      address(address: $owner) {
        balances {
          nodes {
            coinType { repr }
            totalBalance
          }
        }
      }
    }
  `

  const res = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner } })
  })

  const json = await res.json()

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`)
  }

  return json.data?.address?.balances?.nodes ?? []
}

// --- Step 2: fetch decimals/symbol for a given coin type ---
export async function fetchCoinMetadata(coinType) {
  const query = `
    query CoinMeta($type: String!) {
      coinMetadata(coinType: $type) {
        decimals
        symbol
        name
      }
    }
  `

  const res = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { type: coinType } })
  })

  const json = await res.json()
  return json.data?.coinMetadata ?? null
}

// --- Step 3: combine raw balances with decimals into human-readable amounts ---
export async function buildWalletReport(owner) {
  const rawBalances = await fetchWalletBalances(owner)

  const enriched = await Promise.all(
    rawBalances.map(async (b) => {
      const coinType = b.coinType.repr
      const metadata = await fetchCoinMetadata(coinType)
      const decimals = metadata?.decimals ?? 0
      const amount = Number(b.totalBalance) / Math.pow(10, decimals)

      return {
        coinType,
        symbol: metadata?.symbol ?? null,
        name: metadata?.name ?? null,
        decimals,
        rawBalance: b.totalBalance,
        amount
      }
    })
  )

  return enriched
}

// --- Step 4: fetch NAVI protocol lending/borrowing positions ---
// getLendingStateFn/getHealthFactorFn/client are injectable so tests can
// substitute fakes instead of hitting the real SDK + network -- see
// tests/index.test.js. Production never passes a client and relies on the
// SDK's own default (a working gRPC client as of @naviprotocol/lending 2.x).
export async function buildNaviReport(
  owner,
  { client, getLendingStateFn = getLendingState, getHealthFactorFn = getHealthFactor } = {}
) {
  const options = client ? { client } : undefined
  const positions = await getLendingStateFn(owner, options)
  const healthFactor = await getHealthFactorFn(owner, options)

  const simplified = positions.map((p) => ({
    market: p.market,
    assetId: p.assetId,
    symbol: p.pool?.token?.symbol ?? null,
    coinType: p.pool?.coinType ?? null,
    supplyBalance: p.supplyBalance,
    borrowBalance: p.borrowBalance,
    // NAVI normalizes supply/borrow balances to 9 decimals regardless of underlying token
    supplyAmount: Number(p.supplyBalance) / 1e9,
    borrowAmount: Number(p.borrowBalance) / 1e9,
    priceUsd: p.pool?.token?.price ?? null
  }))

  return { positions: simplified, healthFactor }
}

// --- Assemble the full report (same shape main() has always written) ---
export async function buildReport(owner) {
  const [wallet, navi] = await Promise.all([
    buildWalletReport(owner),
    buildNaviReport(owner)
  ])

  return {
    address: owner,
    generatedAt: new Date().toISOString(),
    wallet: { coins: wallet },
    navi
  }
}

// --- Main (CLI entry point only -- not run on import, so this module can be
// imported by tests without WALLET_ADDRESS set or a live report being built) ---
async function main() {
  const address = process.env.WALLET_ADDRESS

  if (!address) {
    console.error('Error: WALLET_ADDRESS environment variable is required')
    process.exit(1)
  }

  console.log(`Fetching report for ${address}...`)

  const report = await buildReport(address)

  mkdirSync('output', { recursive: true })
  writeFileSync('output/wallet-report.json', JSON.stringify(report, null, 2))

  console.log('Report written to output/wallet-report.json')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Failed to generate report:', err)
    process.exit(1)
  })
}
