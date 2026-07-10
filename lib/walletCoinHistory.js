import { graphqlQuery } from './graphqlClient.js'

const TX_PAGE_SIZE = 50

/**
 * Replays this wallet's own balanceChanges from a resume point up to (and
 * including) targetCheckpoint, producing one snapshot per UTC day crossed
 * along the way, plus a new resume cursor for the next call.
 *
 * This is fundamentally sequential and stateful - unlike the NAVI side, there
 * is no on-chain aggregate we can point-read for "balance at date X" (see the
 * /sui-holdings-now investigation: Address.balances only has ~1hr retention).
 * So the only way to know a balance at a past date is to derive it ourselves
 * from the full history of deltas.
 *
 * @param {object} params
 * @param {string} params.address
 * @param {number} params.targetCheckpoint - stop once a transaction's own
 *   checkpoint exceeds this; don't apply it, that's the next call's problem
 * @param {number|null} params.resumeCheckpoint - last checkpoint already
 *   processed by a prior call, or null to start from genesis
 * @param {Record<string,string>} params.resumeBalances - coinType -> raw
 *   balance (as a string, since these can exceed Number's safe integer range)
 */
export async function reconstructWalletCoinHistory({
  address,
  targetCheckpoint,
  resumeCheckpoint = null,
  resumeBalances = {}
}) {
  const balances = new Map(
    Object.entries(resumeBalances).map(([coinType, raw]) => [coinType, BigInt(raw)])
  )

  const dailySnapshots = []
  let currentDay = null
  let lastCheckpointOfCurrentDay = null
  let lastProcessedCheckpoint = resumeCheckpoint
  let after = null

  const snapshotFor = (day, checkpoint) => ({
    date: day,
    checkpoint,
    // Only include non-zero balances - a coin fully withdrawn shouldn't
    // linger in the snapshot as a "0" entry.
    coins: Object.fromEntries(
      [...balances.entries()]
        .filter(([, amount]) => amount > 0n)
        .map(([coinType, amount]) => [coinType, amount.toString()])
    )
  })

  paginationLoop: while (true) {
    const data = await graphqlQuery(
      `
        query WalletTransactions($addr: SuiAddress!, $after: String, $pageSize: Int!) {
          transactions(
            first: $pageSize
            after: $after
            filter: { affectedAddress: $addr }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              digest
              checkpoint { sequenceNumber timestamp }
              effects {
                balanceChanges {
                  nodes { owner { address } amount coinType { repr } }
                }
              }
            }
          }
        }
      `,
      { addr: address, after, pageSize: TX_PAGE_SIZE }
    )

    const { nodes, pageInfo } = data.transactions

    for (const tx of nodes) {
      const seq = tx.checkpoint?.sequenceNumber
      const timestamp = tx.checkpoint?.timestamp

      if (seq == null || timestamp == null) {
        // Shouldn't happen for a finalized transaction - skip defensively
        // rather than crash the whole run over one odd node.
        console.warn(`Skipping ${tx.digest}: missing checkpoint/timestamp`)
        continue
      }

      // Already applied by a previous run - our filter starts from genesis
      // every time (GraphQL has no ">checkpoint N" transaction filter as far
      // as we've found), so we just skip forward past the resume point.
      if (resumeCheckpoint != null && seq <= resumeCheckpoint) continue

      // Walked past what this call was asked to reconstruct - stop, don't
      // apply this transaction. The next call (for a later date) picks up
      // here via the cursor this call returns.
      if (seq > targetCheckpoint) break paginationLoop

      const day = timestamp.slice(0, 10) // YYYY-MM-DD, UTC

      if (currentDay !== null && day !== currentDay) {
        dailySnapshots.push(snapshotFor(currentDay, lastCheckpointOfCurrentDay))
      }
      currentDay = day
      lastCheckpointOfCurrentDay = seq

      for (const change of tx.effects.balanceChanges.nodes) {
        // A transaction can carry balance changes for other addresses too
        // (e.g. swap counterparties, pool objects) - only apply our own.
        if (change.owner?.address !== address) continue

        const coinType = change.coinType.repr
        const delta = BigInt(change.amount)
        balances.set(coinType, (balances.get(coinType) ?? 0n) + delta)
      }

      lastProcessedCheckpoint = seq
    }

    if (!pageInfo.hasNextPage) break
    after = pageInfo.endCursor
  }

  if (currentDay !== null) {
    dailySnapshots.push(snapshotFor(currentDay, lastCheckpointOfCurrentDay))
  }

  return {
    dailySnapshots,
    newCursor: {
      checkpoint: lastProcessedCheckpoint,
      balances: Object.fromEntries(
        [...balances.entries()].map(([coinType, amount]) => [coinType, amount.toString()])
      )
    }
  }
}
