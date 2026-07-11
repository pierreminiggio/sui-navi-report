# AGENTS.md

This file is for an AI agent (or a human moving fast) picking up work on this
project later. It captures things that aren't obvious from reading the code
alone: the mental model behind the design, facts about Sui/NAVI's on-chain
architecture that took real investigation to pin down, every wrong guess that
turned into a real bug (and how it was caught), and known object addresses
worth not re-deriving from scratch.

Read this before changing `reconstruct.js` or anything under `lib/`. The
live path (`index.js`) is comparatively simple and mostly self-explanatory;
almost everything below is about the historical reconstruction path, which
was built through a long, adversarial back-and-forth of hypothesis -> test
with a real `curl` request -> confirm or correct.

## The one rule that matters more than any other

**Never guess a GraphQL field name, an SDK response shape, or an on-chain
object's structure. Test it with a real request first.** This project's
history is a long list of confident-sounding guesses that turned out wrong in
concrete, silent ways:

- Assumed `Transaction.checkpoint` was a top-level field. Wrong - it's
  `Transaction.effects.checkpoint`. Caused an immediate, loud GraphQL
  validation error (the easy kind of wrong to catch).
- Assumed NAVI's `getPools()` SDK response had a field called `assetId`.
  Wrong - it's `id`. This one was **silent**: the field was just `undefined`
  and JSON.stringify quietly dropped it from every output, across 96
  snapshots, before anyone noticed.
- Assumed `contract.reserveId` in `getPools()` would be populated for every
  pool. Wrong for `rwa`-market pools specifically - it's an empty string
  there, which is falsy in JS, so a naive `.filter((p) => p.reserveId)`
  silently deleted every rwa position from every reconstruction run without
  any error at all.
- Assumed a wrapped `UID` field nested inside a Move struct (like
  `reserve.supply_balance.user_state.id`) would resolve like a normal object
  address via `object(address: ...)`. Wrong - it returns `null` unless you go
  through the parent object first via `.extract(path)` -> `.asAddress` ->
  `.addressAt(checkpoint)`. This one has bitten the project twice (once for
  `main`, once again for `rwa`, despite already "knowing" the pattern -
  it's easy to assume a new object won't need the same dance).
- Assumed one silent failure mode (a caught GraphQL error for one pool)
  was safe to treat the same as "this wallet has no position here."
  It produced a wrong-but-plausible-looking snapshot (a real supply position
  vanished for exactly one day, then reappeared) that was only caught because
  the numbers stopped being monotonic and looked wrong by eye.

The fix in every case was the same: stop, write a minimal `curl` request
against `https://graphql.mainnet.sui.io/graphql` (or inspect a real
transaction's `objectChanges`) to see the actual shape of the actual data,
*then* write code against what was actually observed. When in doubt, this is
still the right move - re-verify rather than extend a pattern to a new case
by assumption.

## Mental model: two fundamentally different reconstruction strategies

The single most important design decision in this project, and the reason
`walletCoinHistory.js` and `naviHistory.js` look nothing alike:

**Wallet coin balances have no historical on-chain aggregate to read.** Sui's
`Address.balances` field is served by a "Consistent Store" that only retains
about an hour of history - confirmed via `serviceConfig.availableRange`
returning a span of ~15,000 checkpoints (~1 hour) for that field. There is no
paid tier or archival trick that fixes this; it's architectural. So the only
way to know a balance at a past date is to **replay every transaction from
genesis (or a resume point) and sum the deltas**. This makes wallet-coin
reconstruction inherently **sequential and stateful** - hence the
`resume_checkpoint` / `resume_wallet_balances` cursor.

**NAVI positions, by contrast, ARE stored as a historical on-chain
aggregate.** NAVI's lending contract keeps a pool-wide interest index
(`current_supply_index` / `current_borrow_index`, ray-scaled at 1e27) and
each user's *scaled* balance in a dynamic-field table, and this project
confirmed - by directly querying checkpoints from June 2024, June 2025, and
June 2026 - that Sui's GraphQL RPC can read this object's state **at any past
checkpoint**, not just the current tip. So NAVI reconstruction needs no
replay and no cursor at all: `historical_balance(date) = scaled_balance(date)
x index(date) / 1e27`, both terms read directly at the checkpoint for that
date. This makes it **stateless** - every date is an independent lookup.

Do not "simplify" this into one shared mechanism. They're different because
the underlying chain data really is different in kind, not because of
arbitrary design taste.

## Sui architecture facts (verified, not assumed)

- **JSON-RPC is being fully retired** (public endpoints shutting down around
  July 31, 2026). GraphQL RPC + gRPC are the supported path going forward.
  This project only ever used GraphQL RPC
  (`https://graphql.mainnet.sui.io/graphql`), which is the right call.
- **Checkpoints are the unit of historical scoping.** `checkpoint(sequenceNumber:
  N) { timestamp query { ... } }` lets you scope an entire nested query to
  the chain state as of checkpoint N. `checkpointForDate.js` binary-searches
  checkpoint timestamps to resolve a UTC date to "the last checkpoint at or
  before 23:59:59.999 UTC that day" - roughly log2(current tip) ~= 28-30
  requests per date resolved.
- **Retention varies by field, not just by "how far back."** Confirmed via
  `serviceConfig.availableRange(type, field, filters)`:
  - `Address.balances`: ~1 hour only. Unusable for history.
  - `Query.transactions` filtered by `affectedAddress`: **genesis-deep**
    (`first.sequenceNumber` returned `0`). This is what wallet-coin
    reconstruction relies on.
  - `Query.transactions` filtered by `affectedObject`: only ~29 days deep.
    Not used by this project, but worth remembering if a future feature
    wants "everyone who touched this object," not just "everything one
    wallet did."
  - Direct object reads at a checkpoint (`checkpoint { query { object(address)
    { ... } } }`): confirmed working at least back to June 2024 for a NAVI
    reserve object. Not exhaustively tested further back than that.
- **`Transaction.effects.balanceChanges`** gives the net signed delta per
  coin type per address for a whole transaction - already netted out, no
  need to track individual coin object splits/merges yourself. This is safe
  to rely on directly despite Sui's newer "Address Balance / accumulator"
  system (a parallel-to-Coin-objects balance model): the caveat in Sui's own
  migration docs about needing to separately process "accumulator events"
  only applies if you're deriving balance changes yourself from raw
  checkpoint data. Consuming the already-computed `balanceChanges` field (as
  this project does) already accounts for it - confirmed by cross-checking a
  full genesis-to-present replay against the real live wallet-report and
  getting an **exact** match on every coin balance.
- **`checkpoint` and `timestamp` live under `Transaction.effects`**, not
  directly on `Transaction`. Easy to get wrong (did, twice).
- **Wrapped UIDs need re-scoping before dynamic-field queries work.** A
  `UID` field found nested inside a parent Move struct (e.g.
  `reserve.supply_balance.user_state.id`) is NOT independently addressable
  via a plain `object(address: ...)` query - it returns `null`. You have to
  reach it through the parent: `object(address: parentId) { asMoveObject {
  contents { extract(path: "value.some.nested.id") { asAddress {
  addressAt(checkpoint: N) { dynamicField(name: {type, bcs}) { ... } } } } }
  } }`. `addressAt` is what re-scopes a wrapped UID into something that
  supports dynamic field lookups.
- **Dynamic field keys are BCS-encoded.** An `address` key is just its raw 32
  bytes, base64'd (see `addressEncoding.js`). A `u8` key is a single raw
  byte, base64'd (e.g. `1` -> `"AQ=="`).
- **`dynamicField` (singular, point lookup by known key) is cheap and
  genesis-deep; `dynamicFields` (plural, paginated listing) is flagged in
  Sui's own docs as a "rich query" with likely shallower retention.** Always
  prefer the singular form when the key is already known, which it always is
  here (either an address or a small integer asset ID).

## NAVI architecture facts (verified, not assumed)

- **Package**: `lending_core`, named address
  `0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca`
  (the *original*/genesis package ID - Move.toml named addresses stay fixed
  across upgrades; `published-at` tracks the latest version separately).
  NAVI upgraded this package around November 2025; module names and struct
  shapes stayed the same across that upgrade, and the same shared object
  addresses (e.g. the SUI reserve) kept working unchanged before and after -
  confirmed by reading the same object at checkpoints on both sides of the
  upgrade boundary.
- **Core event types** (from `lending_core/sources/lending.move`, public on
  GitHub): `DepositEvent { reserve: u8, user: address, amount: u64 }`,
  `WithdrawEvent { reserve: u8, user: address, to: address, amount: u64 }`,
  `BorrowEvent`, `RepayEvent`, `LiquidationCallEvent`. **Not currently used**
  by this project - see "Why events aren't used" below - but confirmed
  correct and worth knowing about if a future feature needs them.
- **The accounting model is a classic rebasing-share design** (same family as
  Aave's aTokens): each `Reserve`/`ReserveData` struct holds a **pool-wide**
  `current_supply_index` and `current_borrow_index`, ray-scaled at `1e27`.
  A user's real balance is never stored directly - only a *scaled* share
  count, which multiplied by the current index gives the real amount:
  `real = (scaled * index) / RAY`. This is `rayMultiply()` in
  `naviHistory.js`. **Do not confuse the scaled value with the real one** -
  this was a real, shipped bug (`supplyBalance` field held the scaled value
  instead of the post-index raw amount for one iteration, caught by manually
  back-solving the implied index and noticing it didn't land on a plausible
  number for the date).
- **The interest rate itself is pool-wide and utilization-dependent** -
  it depends on aggregate activity from every user of that reserve, not just
  one wallet. This is *why* NAVI reconstruction reads the index directly
  rather than trying to replay rate math from one wallet's own events - the
  index already bakes in everyone's activity, and re-deriving it from a
  single wallet's event history would be wrong (or would require replaying
  the *entire pool's* event history, which is a much heavier, unnecessary
  approach given the index is just directly readable).
- **Why events aren't used for principal either, despite `DepositEvent` etc.
  being confirmed and available**: once it was confirmed that a user's
  *scaled* balance is directly readable from the same dynamic-field table the
  index lives next to, event replay became unnecessary for NAVI entirely -
  both principal and interest come from the same two direct reads per
  asset per date. This is simpler and cheaper than replay, and was only
  discovered by testing a hypothesis (walk the transaction's `objectChanges`
  looking for the raw table) rather than assuming events were needed because
  they existed.
- **`main` and `rwa` (aka "Isolated Markets", launched ~April 2026) are the
  *same codebase*, just separate instances of the same `Storage` object
  type.** This was gotten wrong once during investigation (assumed rwa was
  an architecturally distinct system based on marketing language in NAVI's
  docs about "Isolated Markets") and only corrected by finding the literal
  `storage::Storage` struct type on both a `main`-market object and a
  transaction that touched an `rwa`-market position. The practical
  consequence: all the same query mechanics (wrapped-UID extraction, ray
  math, dynamic-field lookups) work unchanged for `rwa` - the only real
  difference is which `Storage` instance and which reserve address to start
  from, since `getPools()`'s SDK response doesn't expose `rwa` reserve
  addresses the way it does for `main` (see `KNOWN_RWA_RESERVE_IDS` below).
- **`getPools({ markets: ['main', 'rwa'] })`'s exact response shape**,
  confirmed via a real diagnostic dump (not assumed):
  - `p.id` - the numeric asset ID (NOT `p.assetId`, despite that being the
    more obvious guess - `assetId` genuinely doesn't exist on the response).
  - `p.market` - `"main"` or `"rwa"`, a plain string, reliable.
  - `p.token.symbol`, `p.token.price` - reliable.
  - `p.coinType` - reliable, but note it lacks the `0x` prefix (matches the
    live path's own pre-existing convention for `navi.positions[].coinType`,
    this isn't a new inconsistency).
  - `p.contract.reserveId` - reliable and directly usable **for `main` only**.
    Empty string (`""`, falsy) for every `rwa` pool. This is a genuine SDK
    response gap, not a hint that no such object exists on-chain - it does,
    it's just not surfaced here.
  - `p.contract.pool` - populated for both markets, but **do not use this for
    accounting data**. For `main` it's the flash-loan liquidity/treasury
    object (`{balance, treasury_balance, decimal}` only - confirmed via a
    direct query, no index, no user table). For `rwa` it's the same kind of
    bare liquidity object, confirmed via the same test. It happens to be a
    real `pool::Pool<T>` Move object either way, but it's the wrong Pool for
    reading balances.

## Known object addresses (won't need re-deriving)

| What | Address | Notes |
|---|---|---|
| `lending_core` package (named address) | `0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca` | Stable across the Nov 2025 upgrade |
| SUI reserve (`main`, assetId 0) | `0xab644b5fd11aa11e930d1c7bc903ef609a9feaf9ffe1b23532ad8441854fbfaf` | Confirmed readable at checkpoints spanning June 2024 - June 2026 |
| `rwa`-market `Storage` object | `0x199c1d5c2d58a4b05bbfa2338d02ad2676572a8a59ac148a5475b5c0fc53ed9f` | Found via a real supply transaction's `objectChanges`, not derived generically |
| `rwa` USDC reserve (assetId 0) | `0xc62d059fa9b8fc6b761011e53da9eaf5546dff3641ce7a76db5f42d46345d655` | In `KNOWN_RWA_RESERVE_IDS` |
| `rwa` XAUm reserve (assetId 1) | `0xbc6d15e4c44fc0e77e2fe610c6ea5f3fe04649a254a56186834f585dcfe5cf71` | In `KNOWN_RWA_RESERVE_IDS`; balance cross-checked to an **exact** match against the live report |
| `rwa` XAGm reserve (assetId 2) | `0xded8588df7919375a643f31ecc57a550508224e7b4ed0476ab33f265ed0fba40` | In `KNOWN_RWA_RESERVE_IDS`; discovered but not independently balance-verified |

The `rwa` reserve addresses came from inspecting one wallet's one supply
transaction's `objectChanges` - they happened to touch exactly these three
reserves as a side effect (NAVI appears to update multiple reserves'
accrual state per transaction, not just the one being acted on). **This is
not a generic or complete list.** A first attempt to read the `rwa` Storage
object's own dynamic fields directly (keyed by `u8` assetId, the same way
`main` reserves are structured) returned `null` and wasn't investigated
further - so there's no known generic way to resolve a new `rwa` asset's
reserve address yet. If NAVI adds a fourth `rwa` asset, find its address the
same way this project did: find (or trigger) a real transaction touching it,
pull `effects.objectChanges`, and look for a `Field<u8,
lending_core::storage::ReserveData>` entry.

## Reconstruction algorithm, end to end

1. `reconstruct.js` resolves `TARGET_DATE` to a checkpoint via
   `checkpointForDate()` (binary search on checkpoint timestamps).
2. `reconstructWalletCoinHistory()` walks `Query.transactions` filtered by
   `affectedAddress`, from `RESUME_CHECKPOINT` (or genesis) forward, summing
   `effects.balanceChanges` for the wallet's own address, and snapshots the
   running total every time a transaction's UTC day differs from the
   previous one. Stops (without applying) the first transaction whose
   checkpoint exceeds the target - that transaction becomes the starting
   point of a future call. Returns every snapshot walked through, not just
   the last one, plus a `newCursor` for resuming.
3. For each of those daily snapshots, `reconstructNaviPositionsAt()` does
   two direct reads per known pool (reserve index + this wallet's
   dynamic-field table entry), all scoped to that snapshot's own checkpoint
   (not the overall target checkpoint - each day gets its own accurate
   point-in-time read).
4. Everything gets assembled into the same shape `index.js`'s live report
   uses, tagged with `source: "reconstructed"` and `asOfDate`, and written
   as one artifact covering the whole walked range.

## Known limitations (see README.md for the user-facing version)

- No NFT/non-fungible-object history (structural: `balanceChanges` only
  tracks `Coin<T>`, not arbitrary owned objects). Confirmed intentional -
  explicitly out of scope per product decision, not a bug to fix.
- `navi.healthFactor` and `navi.positions[].priceUsd` reflect **today's**
  values, not the historical date's, in reconstructed reports. Reconstructing
  these faithfully would need each asset's oracle price *as of that
  checkpoint*, which hasn't been tested yet (see "Ideas for future work").
- `rwa` support is limited to the three known reserve addresses above.
- Snapshots only exist for days with actual wallet or (indirectly) NAVI
  activity - a quiet stretch produces no snapshot for those days at all. A
  consumer wanting "holdings as of date X" needs carry-forward semantics
  (most recent snapshot at or before X), not an exact-day match. This is a
  deliberate API-layer concern, not something `reconstruct.js` should try to
  paper over by writing redundant identical snapshots.

## Ideas for future work (not started, not verified)

- **Historical `priceUsd`/`healthFactor`**: NAVI's oracle price is itself
  likely on-chain object state (a `PriceOracle` object was seen in a real
  transaction's `objectChanges` during the rwa investigation, package
  `0xca441b44943c16be0e6e23c5a955bb971537ea3289ae8016fbf33fffe1fd210f`) and
  might be checkpoint-readable the same way reserve data is. Untested.
  Follow the same "curl it before writing code" discipline before assuming
  this works.
- **A generic `rwa` reserve resolver**: investigate why a direct
  `dynamicField` lookup on the rwa `Storage` object (keyed by `u8` assetId)
  returned `null` - the sub-table might be nested one level deeper than
  assumed (similar to how `main`'s per-user tables are nested inside the
  reserve, not on the reserve's own top-level `id`).
- **NFT/object-transfer history**: would need a different mechanism entirely
  (object-ownership change events, not `balanceChanges`). Not started.

## Testing philosophy used to build this (worth continuing)

- Prefer testing a real, minimal `curl` request over writing code against an
  assumption, every time a new field/object/query shape is involved.
- When something looks wrong in output, don't just eyeball plausibility -
  cross-check by hand. The scaled-vs-real-balance bug was caught by manually
  back-solving what index value would make a suspicious number correct, and
  noticing it didn't land in the plausible range for that date. The
  transient-failure bug was caught by noticing a position violated
  monotonicity (dropped to zero for one day, came back higher than before),
  then *proving* it wasn't real trading activity by cross-referencing the
  wallet's own transaction history for that exact day.
- **Validate against real ground truth whenever possible.** This project had
  a real live report available from the very first message of the
  conversation that started it - reconstructing up to a date close to that
  report's generation time and diffing against it caught both the `assetId`
  bug and confirmed the wallet-coin replay was exactly correct (bit-for-bit
  identical balances after a 9.5-month, 96-snapshot walk). If a real
  reference point exists, use it before trusting internal consistency alone.
- A wrong guess that fails loudly (a GraphQL validation error) is much
  cheaper than one that fails silently (a field quietly becoming `undefined`,
  a falsy-string filter silently dropping data). When writing new code
  against inferred shapes, prefer patterns that would error or warn loudly if
  the assumption is wrong, over patterns that would silently degrade (see
  `resolveReserveId()`'s explicit `console.warn` when nothing resolves,
  and the retry-then-fail-loud logic in `reconstructNaviPositionsAt()`).
