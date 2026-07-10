import { writeFileSync, mkdirSync } from 'fs'
import { getPools } from '@naviprotocol/lending'
import { fetchCoinMetadata } from './lib/graphqlClient.js'
import { checkpointForDate } from './lib/checkpointForDate.js'
import { reconstructWalletCoinHistory } from './lib/walletCoinHistory.js'
import { reconstructNaviPositionsAt } from './lib/naviHistory.js'
import { addressToBcsBase64 } from './lib/addressEncoding.js'

const address = process.env.WALLET_ADDRESS
const targetDate = process.env.TARGET_DATE
const resumeCheckpoint = process.env.RESUME_CHECKPOINT
  ? Number(process.env.RESUME_CHECKPOINT)
  : null
const resumeBalances = process.env.RESUME_WALLET_BALANCES
  ? JSON.parse(process.env.RESUME_WALLET_BALANCES)
  : {}

if (!address) {
  console.error('Error: WALLET_ADDRESS environment variable is required')
  process.exit(1)
}

if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  console.error('Error: TARGET_DATE environment variable is required, in YYYY-MM-DD format')
  process.exit(1)
}

// --- Enrich raw wallet-coin balances (coinType -> raw amount) with the same
// symbol/name/decimals shape the live report already produces ---
async function enrichCoins(rawCoins) {
  const entries = Object.entries(rawCoins)

  return Promise.all(
    entries.map(async ([coinType, rawBalance]) => {
      const metadata = await fetchCoinMetadata(coinType)
      const decimals = metadata?.decimals ?? 0

      return {
        coinType,
        symbol: metadata?.symbol ?? null,
        name: metadata?.name ?? null,
        decimals,
        rawBalance,
        amount: Number(rawBalance) / Math.pow(10, decimals)
      }
    })
  )
}

async function main() {
  console.log(`Reconstructing ${address} up to ${targetDate}...`)

  const targetCheckpoint = await checkpointForDate(targetDate)
  console.log(`Target date resolved to checkpoint ${targetCheckpoint}`)

  // --- Wallet coins: sequential replay from the resume cursor (or genesis) ---
  const { dailySnapshots, newCursor } = await reconstructWalletCoinHistory({
    address,
    targetCheckpoint,
    resumeCheckpoint,
    resumeBalances
  })

  if (dailySnapshots.length === 0) {
    console.log('No wallet activity found between the resume point and the target date.')
  }

  // --- NAVI: independent point-in-time read per snapshot day, no cursor ---
  // Pool metadata (reserveId, coinType, decimals, current price) is fetched
  // live - reserveId itself is a stable object address over time (confirmed
  // across NAVI's Nov 2025 package upgrade), only the *contents* we read are
  // checkpoint-scoped.
  const rawPools = await getPools({ markets: ['main', 'rwa'] })
  const pools = rawPools.map((p) => ({
    market: p.market,
    assetId: p.assetId,
    symbol: p.token?.symbol ?? null,
    coinType: p.coinType ?? null,
    reserveId: p.contract?.reserveId,
    priceUsd: p.token?.price ?? null
  })).filter((p) => p.reserveId)

  const userKeyBcs = addressToBcsBase64(address)

  const reports = []

  for (const snapshot of dailySnapshots) {
    const navi = await reconstructNaviPositionsAt({
      address,
      checkpoint: snapshot.checkpoint,
      pools,
      userKeyBcs
    })

    const coins = await enrichCoins(snapshot.coins)

    reports.push({
      date: snapshot.date,
      report: {
        address,
        generatedAt: new Date().toISOString(),
        asOfDate: snapshot.date,
        source: 'reconstructed',
        wallet: { coins },
        navi
      }
    })

    console.log(`Reconstructed ${snapshot.date} (checkpoint ${snapshot.checkpoint})`)
  }

  mkdirSync('output', { recursive: true })
  writeFileSync(
    'output/reconstruction-result.json',
    JSON.stringify({ newCursor, dailySnapshots: reports }, null, 2)
  )

  console.log(
    `Wrote ${reports.length} daily snapshot(s). New cursor: checkpoint ${newCursor.checkpoint}.`
  )
}

main().catch((err) => {
  console.error('Reconstruction failed:', err)
  process.exit(1)
})
