import { graphqlQuery, withRetries } from './graphqlClient.js'

const RAY = 10n ** 27n

/**
 * Reads one pool's reserve object at a given checkpoint, plus this wallet's
 * entry (if any) in both the supply and borrow dynamic-field tables, in a
 * single request. This is the query shape confirmed working against the SUI
 * reserve across three checkpoints spanning June 2024 - June 2026:
 *
 *   object(reserveId) -> asMoveObject.contents
 *     .extract("value.supply_balance.user_state.id") -> asAddress
 *     -> addressAt(checkpoint) -> dynamicField(name: {type: "address", bcs})
 *
 * The `.id` fields inside the reserve struct are wrapped objects (UIDs nested
 * in a parent Move value), which is why a plain top-level object(address:...)
 * lookup on them returns null - confirmed the hard way during investigation.
 * They have to be reached through the parent reserve object and re-scoped via
 * addressAt() before they support dynamic field queries.
 */
async function readReserveAndUserEntries({ reserveId, checkpoint, userKeyBcs }) {
  const data = await graphqlQuery(
    `
      query NaviReserveAt($reserveId: SuiAddress!, $checkpoint: UInt53!, $userKeyBcs: String!) {
        checkpoint(sequenceNumber: $checkpoint) {
          query {
            object(address: $reserveId) {
              asMoveObject {
                contents {
                  reserveJson: json
                  supplyEntry: extract(path: "value.supply_balance.user_state.id") {
                    asAddress {
                      addressAt(checkpoint: $checkpoint) {
                        dynamicField(name: { type: "address", bcs: $userKeyBcs }) {
                          value { __typename ... on MoveValue { json } }
                        }
                      }
                    }
                  }
                  borrowEntry: extract(path: "value.borrow_balance.user_state.id") {
                    asAddress {
                      addressAt(checkpoint: $checkpoint) {
                        dynamicField(name: { type: "address", bcs: $userKeyBcs }) {
                          value { __typename ... on MoveValue { json } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { reserveId, checkpoint, userKeyBcs }
  )

  const contents = data.checkpoint?.query?.object?.asMoveObject?.contents

  if (!contents) {
    // The reserve object didn't exist yet at this checkpoint (asset not yet
    // listed on NAVI at that date) - not an error, just "no position possible".
    return null
  }

  const reserve = contents.reserveJson.value

  const supplyScaled = contents.supplyEntry?.asAddress?.addressAt?.dynamicField?.value?.json ?? null
  const borrowScaled = contents.borrowEntry?.asAddress?.addressAt?.dynamicField?.value?.json ?? null

  return {
    currentSupplyIndex: BigInt(reserve.current_supply_index),
    currentBorrowIndex: BigInt(reserve.current_borrow_index),
    // null here means this wallet has no entry in the table at all yet at
    // this checkpoint (never supplied/borrowed this asset as of that date) -
    // distinct from "entry exists with value 0", though both mean 0 balance.
    userScaledSupply: supplyScaled != null ? BigInt(supplyScaled) : 0n,
    userScaledBorrow: borrowScaled != null ? BigInt(borrowScaled) : 0n
  }
}

/**
 * Ray-multiplies a scaled balance by its index, returning the post-index raw
 * amount as a BigInt - this is the same quantity the live SDK path's
 * supplyBalance/borrowBalance fields represent (see index.js's
 * buildNaviReport), NOT the pre-index scaled share count. Getting this
 * distinction wrong was caught by cross-checking a reconstructed amount
 * against its expected index during testing: dividing the scaled value
 * directly by 1e9 silently produced a plausible-looking but wrong number.
 */
function rayMultiply(scaled, index) {
  return (scaled * index) / RAY
}

function toHumanAmount(raw) {
  return Number(raw) / 1e9
}

/**
 * Reads this wallet's NAVI positions across every given pool, all at the
 * exact same checkpoint - meaning, unlike the wallet-coin side, this needs no
 * resume cursor at all. Every date is an independent lookup.
 *
 * @param {object} params
 * @param {string} params.address
 * @param {number} params.checkpoint
 * @param {Array<{market: string, assetId: number, symbol: string, coinType: string, reserveId: string, priceUsd: number|null}>} params.pools
 *   Pool metadata (reserveId, symbol, coinType, etc) - fetched live via the
 *   @naviprotocol/lending SDK's getPools(), since reserveId is a stable
 *   object address over time (confirmed: same SUI reserveId resolved
 *   correctly across NAVI's Nov 2025 package upgrade). Only the reserve's
 *   *contents* are checkpoint-scoped, not which reserveId to look at.
 * @param {string} params.userKeyBcs - this wallet's address, BCS-encoded
 *   (raw 32 bytes) and base64'd - the dynamic field table key
 */
export async function reconstructNaviPositionsAt({ address, checkpoint, pools, userKeyBcs }) {
  const positions = []

  for (const pool of pools) {
    // Retries a few times before giving up - a genuine "this reserve didn't
    // exist yet at this checkpoint" returns null from readReserveAndUserEntries
    // (not a thrown error), so it's never retried or mistaken for a failure.
    // Anything that *does* throw here (rate limit, timeout, malformed
    // response) is a real fetch failure, not "no position" - after retries
    // are exhausted we let it propagate and fail the whole run loudly rather
    // than silently write a snapshot that's missing this pool's position.
    // (This is exactly the bug that produced a wrong SUI/vSUI-free snapshot
    // for one day during testing - confirmed via the wallet's own transaction
    // history showing no withdrawal that day, just an ordinary gas fee.)
    const entries = await withRetries(() =>
      readReserveAndUserEntries({ reserveId: pool.reserveId, checkpoint, userKeyBcs })
    )

    if (!entries) continue

    const supplyRaw = rayMultiply(entries.userScaledSupply, entries.currentSupplyIndex)
    const borrowRaw = rayMultiply(entries.userScaledBorrow, entries.currentBorrowIndex)
    const supplyAmount = toHumanAmount(supplyRaw)
    const borrowAmount = toHumanAmount(borrowRaw)

    if (supplyAmount === 0 && borrowAmount === 0) continue

    positions.push({
      market: pool.market,
      assetId: pool.assetId,
      symbol: pool.symbol,
      coinType: pool.coinType,
      supplyBalance: String(supplyRaw),
      borrowBalance: String(borrowRaw),
      supplyAmount,
      borrowAmount,
      priceUsd: pool.priceUsd ?? null
    })
  }

  // Note: healthFactor is NOT reconstructed here. It's a live risk metric
  // (aggregate LTV/liquidation math across all positions using current
  // prices), not a stored balance - reconstructing it faithfully would need
  // the asset's oracle price *as of that checkpoint* for every position, which
  // we haven't verified is readable the same way (see open items). Left as
  // null for now rather than guessing with today's prices.
  return { positions, healthFactor: null }
}
