import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildWalletReport, buildNaviReport } from '../index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/live-report.golden.json'), 'utf8')
)

// Reconstructs the GraphQL responses that would have to come back from
// graphql.mainnet.sui.io to produce golden.wallet.coins exactly -- so a pass
// here proves buildWalletReport's own transformation logic is unchanged,
// independent of transport. (buildWalletReport already only talks GraphQL, so
// this suite mainly exists as a safety net / shape contract, not because the
// fix touches this function.)
function mockGraphqlFetchFromGolden() {
  return async (_url, init) => {
    const body = JSON.parse(init.body)

    if (body.query.includes('WalletHoldings')) {
      return {
        json: async () => ({
          data: {
            address: {
              balances: {
                nodes: golden.wallet.coins.map((c) => ({
                  coinType: { repr: c.coinType },
                  totalBalance: c.rawBalance
                }))
              }
            }
          }
        })
      }
    }

    if (body.query.includes('CoinMeta')) {
      const coin = golden.wallet.coins.find((c) => c.coinType === body.variables.type)

      return {
        json: async () => ({
          data: {
            coinMetadata: coin
              ? { decimals: coin.decimals, symbol: coin.symbol, name: coin.name }
              : null
          }
        })
      }
    }

    throw new Error(`Unexpected GraphQL query in test: ${body.query}`)
  }
}

test('buildWalletReport reproduces the known-good wallet.coins shape and values', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockGraphqlFetchFromGolden()

  try {
    const coins = await buildWalletReport(golden.address)
    assert.deepEqual(coins, golden.wallet.coins)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// Reconstructs the NAVI SDK pool objects that would have to come back from
// getLendingState() to produce golden.navi.positions exactly.
function poolInputsFromGolden() {
  return golden.navi.positions.map((p) => ({
    market: p.market,
    assetId: p.assetId,
    supplyBalance: p.supplyBalance,
    borrowBalance: p.borrowBalance,
    pool: { coinType: p.coinType, token: { symbol: p.symbol, price: p.priceUsd } }
  }))
}

test('buildNaviReport reproduces the known-good navi shape and values', async () => {
  const calls = []
  const fakeClient = { __fake: 'injected-sui-client' }

  const getLendingStateFn = async (owner, options) => {
    calls.push(['getLendingState', owner, options])
    return poolInputsFromGolden()
  }

  const getHealthFactorFn = async (owner, options) => {
    calls.push(['getHealthFactor', owner, options])
    return golden.navi.healthFactor
  }

  const navi = await buildNaviReport(golden.address, {
    client: fakeClient,
    getLendingStateFn,
    getHealthFactorFn
  })

  assert.deepEqual(navi, golden.navi)
  assert.equal(calls.length, 2, 'expected exactly one getLendingState + one getHealthFactor call')

  // This is the actual regression the fix targets: NAVI's default client
  // builds transactions against a JSON-RPC public full node, which Sui
  // retired the week of July 27, 2026 (-32601 Method not found). Both calls
  // must be given an explicit client rather than falling back to that dead
  // default.
  for (const [name, owner, options] of calls) {
    assert.equal(owner, golden.address, `${name} called with the wrong owner`)
    assert.equal(options?.client, fakeClient, `${name} was not called with the injected client`)
  }
})

test('buildNaviReport defers to the SDK\'s own default client when none is injected', async () => {
  let capturedOptions

  const navi = await buildNaviReport(golden.address, {
    getLendingStateFn: async (_owner, options) => {
      capturedOptions = options
      return []
    },
    getHealthFactorFn: async () => 0
  })

  // We deliberately do NOT construct our own client anymore: as of
  // @naviprotocol/lending 2.0.8, the SDK's own default is a correctly-configured
  // gRPC client (verified by reading node_modules/@naviprotocol/lending/dist/sui.js).
  // Forcing a client here would just be us second-guessing a dependency that
  // already fixed itself -- and is exactly the kind of assumption that broke
  // the previous (GraphQL-transport) attempt at this fix.
  assert.equal(
    capturedOptions,
    undefined,
    'buildNaviReport should not force a client when none is injected'
  )
  assert.deepEqual(navi.positions, [])
})
