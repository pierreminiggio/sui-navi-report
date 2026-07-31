import { getLendingState, getHealthFactor } from '@naviprotocol/lending'
import { SuiClient } from '@mysten/sui/client'
import { SuiClientGraphQLTransport } from '@mysten/graphql-transport'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'

const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql'

// getLendingState/getHealthFactor build a short-lived transaction under the hood
// (devInspectTransactionBlock) to read on-chain state, and default to a SuiClient
// pointed at a public JSON-RPC full node. Sui's public JSON-RPC full nodes were
// retired the week of July 27, 2026 (docs.sui.io/references/sui-api), so that
// default now fails with a -32601 "Method not found" JsonRpcError. Passing our
// own SuiClient -- same class the SDK expects, just wired to the GraphQL
// transport we already use for wallet balances above -- avoids the dead
// endpoint. (Not @mysten/sui's newer SuiGrpcClient: @naviprotocol/lending's
// installed version still imports the pre-2.0 SuiClient/devInspectTransactionBlock
// API, so the injected client has to match that same surface.)
function createSuiClient() {
  return new SuiClient({
    transport: new SuiClientGraphQLTransport({ url: SUI_GRAPHQL_URL })
  })
}

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
// Dependencies are injectable (client / getLendingStateFn / getHealthFactorFn)
// so tests can substitute fakes instead of hitting the real SDK + network --
// see tests/index.test.js. Production always uses the real defaults.
export async function buildNaviReport(
  owner,
  {
    client = createSuiClient(),
    getLendingStateFn = getLendingState,
    getHealthFactorFn = getHealthFactor
  } = {}
) {
  const positions = await getLendingStateFn(owner, { client })
  const healthFactor = await getHealthFactorFn(owner, { client })

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
