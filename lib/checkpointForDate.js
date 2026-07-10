import { graphqlQuery } from './graphqlClient.js'

async function getCheckpointTimestampMs(sequenceNumber) {
  const data = await graphqlQuery(
    `
      query CheckpointTimestamp($seq: UInt53!) {
        checkpoint(sequenceNumber: $seq) {
          timestamp
        }
      }
    `,
    { seq: sequenceNumber }
  )

  // A null checkpoint here means we asked for a sequence number that doesn't
  // exist yet (past the current tip) - shouldn't happen given how callers use
  // this, but fail loudly rather than silently treating it as "before target".
  if (!data.checkpoint) {
    throw new Error(`Checkpoint ${sequenceNumber} not found`)
  }

  return new Date(data.checkpoint.timestamp).getTime()
}

async function getLatestCheckpoint() {
  const data = await graphqlQuery(`
    query LatestCheckpoint {
      checkpoint {
        sequenceNumber
        timestamp
      }
    }
  `)

  return data.checkpoint
}

/**
 * Resolves a UTC calendar date (YYYY-MM-DD) to the highest checkpoint sequence
 * number whose timestamp is at or before the end of that day (23:59:59.999 UTC).
 * That checkpoint is what we treat as "end of day X" throughout reconstruction,
 * for both the wallet-coin walk and the NAVI point-in-time reads, so both sides
 * agree on exactly the same on-chain moment for a given date.
 *
 * This does a binary search over checkpoint sequence numbers using their
 * timestamps - roughly log2(currentTip) GraphQL round trips (~28-30 today).
 * Cheap enough for a one-off reconstruction run, but worth remembering if this
 * ever needs to resolve many dates in a single run - see note in reconstruct.js.
 */
export async function checkpointForDate(dateStr, { lowerBound = 0 } = {}) {
  const targetMs = new Date(`${dateStr}T23:59:59.999Z`).getTime()

  if (Number.isNaN(targetMs)) {
    throw new Error(`Invalid date: ${dateStr}, expected YYYY-MM-DD`)
  }

  const latest = await getLatestCheckpoint()
  const latestMs = new Date(latest.timestamp).getTime()

  // Target date is today (or in the future) - nothing to search for, just use
  // the current tip. This also covers the "reconstructing up to today" case,
  // which should really just be going through /sui-holdings-now instead.
  if (targetMs >= latestMs) {
    return latest.sequenceNumber
  }

  let lo = lowerBound
  let hi = latest.sequenceNumber
  let best = null

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const ts = await getCheckpointTimestampMs(mid)

    if (ts <= targetMs) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  if (best === null) {
    // Every checkpoint we tried was after targetMs - the target date predates
    // lowerBound (e.g. predates the wallet's or NAVI's genesis on-chain).
    throw new Error(
      `No checkpoint found at or before ${dateStr} (searched from ${lowerBound})`
    )
  }

  return best
}
