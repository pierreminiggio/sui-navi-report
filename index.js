import { getLendingState, getHealthFactor } from '@naviprotocol/lending'
import { writeFileSync, mkdirSync } from 'fs'

const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql'

const address = process.env.WALLET_ADDRESS

if (!address) {
  console.error('Error: WALLET_ADDRESS environment variable is required')
  process.exit(1)
}

// --- Step 1: fetch raw coin balances owned by the wallet ---
async function fetchWalletBalances(owner) {
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
async function fetchCoinMetadata(coinType) {
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
async function buildWalletReport(owner) {
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
async function buildNaviReport(owner) {
  const positions = await getLendingState(owner)
  const healthFactor = await getHealthFactor(owner)

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

// --- Main ---
async function main() {
  console.log(`Fetching report for ${address}...`)

  const [wallet, navi] = await Promise.all([
    buildWalletReport(address),
    buildNaviReport(address)
  ])

  const report = {
    address,
    generatedAt: new Date().toISOString(),
    wallet: { coins: wallet },
    navi
  }

  mkdirSync('output', { recursive: true })
  writeFileSync('output/wallet-report.json', JSON.stringify(report, null, 2))

  console.log('Report written to output/wallet-report.json')
}

main().catch((err) => {
  console.error('Failed to generate report:', err)
  process.exit(1)
})
