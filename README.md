# SUI Wallet + NAVI Protocol Report

A GitHub Action that takes a SUI wallet address as input and generates a JSON report combining:
- Raw wallet coin holdings (via Sui's public GraphQL RPC)
- NAVI Protocol supply/borrow positions + health factor (via the official NAVI SDK)

The report is uploaded as a downloadable workflow artifact — no server, no API key, no database.

## Project structure

```
sui-navi-report/
├── .github/workflows/wallet-report.yml       # live snapshot Action
├── .github/workflows/wallet-reconstruct.yml  # historical reconstruction Action
├── index.js                                  # builds a live report (unchanged)
├── reconstruct.js                            # builds historical report(s) for past dates
├── lib/
│   ├── graphqlClient.js       # shared GraphQL POST client + coin metadata cache
│   ├── checkpointForDate.js   # binary-searches a UTC date -> checkpoint sequence number
│   ├── walletCoinHistory.js   # sequential wallet-coin balance replay (stateful, cursor-based)
│   ├── naviHistory.js         # NAVI point-in-time position reads (stateless, no cursor)
│   └── addressEncoding.js     # BCS-encodes an address for dynamic-field table lookups
├── package.json
└── README.md
```

## Running it on GitHub (recommended)

1. Push this repo to GitHub as-is (folder structure must be preserved, especially `.github/workflows/`).
2. Go to the **Actions** tab of the repo.
3. Select **SUI Wallet Report** from the left-hand list of workflows.
4. Click **Run workflow** (top right).
5. Paste the wallet address (e.g. `0x77ffeb08306a95f2386467002c71b33e8022bb2ae98dd57ebcdf00d316fccbea`) into the `wallet_address` field and confirm.
6. Wait for the run to go green (takes ~10-20 seconds).
7. Open the completed run's summary page → scroll to **Artifacts** → download `wallet-report` (a zip containing `wallet-report.json`).

## Running it locally

Requires Node.js 20+.

```bash
npm install
WALLET_ADDRESS=0xYOUR_ADDRESS node index.js
```

The report is written to `output/wallet-report.json`.

## Reconstructing historical holdings

`wallet-reconstruct.yml` / `reconstruct.js` answer a different question than the live path above: "what did this wallet hold on some *past* date?" This needed two genuinely different strategies, because SUI coin balances and NAVI positions are retrievable from very different places on-chain:

**Wallet coins are reconstructed by replay, not by direct lookup.** Sui's live balance-aggregation service only retains about an hour of history — there's no way to directly ask "what was this wallet's balance on date X" for anything older. So instead, `walletCoinHistory.js` walks every transaction that ever touched the wallet (Sui's transaction history for a given address goes back to genesis on the public GraphQL endpoint), sums each transaction's `balanceChanges` for our own address, and snapshots the running total at every UTC day boundary crossed along the way.

This makes wallet-coin reconstruction **stateful**: it's inherently sequential (you can't know day 200's balance without knowing day 199's), so each run takes a `resume_checkpoint` + `resume_wallet_balances` pair and returns a `newCursor` for the next run to resume from. **A run only ever walks forward to `target_date` — it never walks further just because more history happens to be available**, so that the cursor always reflects exactly where reconstruction has gotten to, one call at a time.

**NAVI positions are reconstructed by direct historical reads — no replay needed at all.** NAVI stores each asset's interest-accrual state (`current_supply_index` / `current_borrow_index`) and every user's scaled balance as plain on-chain object state, which Sui's GraphQL RPC can read directly at a past checkpoint via `checkpoint(sequenceNumber) { query { object(address) { ... } } }`. So `naviHistory.js` does two direct reads per asset per date — the reserve's index, and this wallet's entry in that reserve's dynamic-field table — multiplies them together, and that's the historical balance. This makes NAVI reconstruction **stateless**: no cursor, no resume state, every date is an independent lookup unrelated to any other.

### Running a reconstruction

Same as the live workflow, but via **SUI Wallet Reconstruction** in the Actions tab, with these inputs:

| Input | Required | Description |
|---|---|---|
| `wallet_address` | yes | Same as the live workflow |
| `target_date` | yes | UTC date (`YYYY-MM-DD`) to reconstruct up to |
| `resume_checkpoint` | no | From a previous run's `newCursor.checkpoint` — omit to start from genesis |
| `resume_wallet_balances` | no | From a previous run's `newCursor.balances` — omit to start from zero |

The artifact (`wallet-reconstruction`) contains `output/reconstruction-result.json`:

```json
{
  "newCursor": {
    "checkpoint": 158700234,
    "balances": { "0x2::sui::SUI": "5117254324" }
  },
  "dailySnapshots": [
    { "date": "2025-09-14", "report": { "...": "same shape as wallet-report.json, plus asOfDate and source" } }
  ]
}
```

Since a single run naturally passes through every intermediate day on its way to `target_date`, `dailySnapshots` contains **all of them**, not just the final day — so one run backfills a whole range, not just one date.

### Known limitations / things not yet reconstructed

- **`navi.healthFactor` is always `null` in reconstructed reports.** It's a live risk calculation (aggregate LTV using *current* oracle prices across all positions), not stored balance data — reconstructing it faithfully would need each asset's oracle price as of that specific checkpoint, which hasn't been verified as readable yet. `navi.positions[].priceUsd` is similarly today's price, not the historical one, for the same reason.
- **Reconstructed reports will never include NFTs or other non-fungible owned objects, even though live reports do.** Confirmed by diffing a reconstructed snapshot against the actual live report from the start of this project: the live report's `honor_badge`/"NFT RECEIVED" object has no counterpart in any reconstructed snapshot. This isn't a bug to fix - it's structural. Wallet-coin reconstruction is built entirely on `balanceChanges`, which only tracks fungible `Coin<T>` deltas; NFTs and other arbitrary Move objects simply don't appear in that field, live report or not. If NFT history matters, it needs its own separate mechanism entirely (likely reading the raw object-ownership transfer events, not balance changes).
- **`getPools()`'s exact response shape was partly wrong, now partly fixed.** A full genesis-to-present test run confirmed `assetId` came back `undefined` on every single position (silently dropped from the JSON rather than erroring) - the guessed field name was wrong. Fixed to read `p.id` first (matching the raw on-chain reserve struct's own field name, which we verified directly via `checkpoint { query { object } }` earlier in this project), falling back to `p.assetId`, with a console warning if neither resolves. Everything else guessed about this response shape (`market`, `token.symbol`, `token.price`, `contract.reserveId`, `coinType`) held up correctly against real data.
- **Reconstruction of dates before the on-chain data itself becomes unavailable will fail loudly** (`checkpointForDate` throws, or a reserve's `object` query returns nothing precisely because it didn't exist yet) rather than silently returning an empty report — this is intentional, per the same reasoning as the API's `/sui-holdings/{address}` endpoint failing rather than guessing.
- **The date→checkpoint binary search costs ~28-30 GraphQL round trips per run.** Fine for one-off/manual reconstruction, but worth batching or caching if this ever needs to resolve many dates per run.



## Output schema

Top-level shape:

```json
{
  "address": "string — the wallet address queried",
  "generatedAt": "string — ISO 8601 timestamp of when the report was generated",
  "wallet": { "coins": [ /* array, see below */ ] },
  "navi": {
    "positions": [ /* array, see below */ ],
    "healthFactor": "number"
  }
}
```

### `wallet.coins[]` — raw coin holdings in the wallet

One entry per coin type the address owns, straight from Sui's chain state (not deposited anywhere).

| Field | Type | Description |
|---|---|---|
| `coinType` | string | Full on-chain coin type identifier |
| `symbol` | string \| null | Token symbol (`SUI`, `USDC`, etc.) — null if metadata isn't registered on-chain |
| `name` | string \| null | Human-readable token name |
| `decimals` | number | Decimal places used to convert `rawBalance` → `amount` |
| `rawBalance` | string | Raw on-chain integer balance (as a string, since it can exceed safe JS integer range) |
| `amount` | number | `rawBalance` already converted using `decimals` — this is the number you actually want |

### `navi.positions[]` — NAVI Protocol lending/borrowing positions

One entry per asset with an active supply or borrow position, across NAVI's `main` and `rwa` markets. Note: a wallet with no NAVI activity at all will still return an entry for every asset NAVI tracks, just with `supplyBalance`/`borrowBalance` at `"0"` — filter on non-zero amounts if you only want active positions.

| Field | Type | Description |
|---|---|---|
| `market` | string | NAVI market this position belongs to (`"main"` or `"rwa"`) |
| `assetId` | number | NAVI's internal numeric ID for the asset (unique within a market, **not** globally — e.g. `assetId: 0` exists in both `main` and `rwa`) |
| `symbol` | string \| null | Token symbol |
| `coinType` | string | Full on-chain coin type identifier |
| `supplyBalance` | string | Raw supplied amount, normalized to 9 decimals by NAVI regardless of the underlying token's actual decimals |
| `borrowBalance` | string | Raw borrowed amount, same 9-decimal normalization |
| `supplyAmount` | number | `supplyBalance` already converted (÷ 1e9) — ready to use |
| `borrowAmount` | number | `borrowBalance` already converted (÷ 1e9) — ready to use |
| `priceUsd` | number \| null | NAVI's internal oracle price for the asset at generation time |

### `navi.healthFactor`

A single number describing liquidation risk across all NAVI borrow positions combined:
- **Above 1** — safe, not at immediate risk of liquidation
- **At or below 1** — at risk of liquidation
- Roughly: closer to 1 = riskier, 2+ = comfortable margin

There's no separate health factor per market — it reflects the wallet's overall NAVI risk.

## Known gotcha: `@mysten/sui` version conflict

`@naviprotocol/lending` depends on `@mysten/sui`, but a fresh `npm install` can pull in a newer version of `@mysten/sui` that removed the `SuiClient` export (in favor of `SuiGrpcClient`), which breaks NAVI's SDK with an error like:

```
SyntaxError: The requested module '@mysten/sui/client' does not provide an export named 'SuiClient'
```

If you hit this in CI, pin `@mysten/sui` explicitly in `package.json` to whatever version `@naviprotocol/lending` expects:

```bash
cat node_modules/@naviprotocol/lending/package.json | grep -A2 '"@mysten/sui"'
```

Then add that exact version to this project's `package.json` dependencies, commit the resulting `package-lock.json`, and re-run.
