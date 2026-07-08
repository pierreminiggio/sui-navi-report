# SUI Wallet + NAVI Protocol Report

A GitHub Action that takes a SUI wallet address as input and generates a JSON report combining:
- Raw wallet coin holdings (via Sui's public GraphQL RPC)
- NAVI Protocol supply/borrow positions + health factor (via the official NAVI SDK)

The report is uploaded as a downloadable workflow artifact — no server, no API key, no database.

## Project structure

```
sui-navi-report/
├── .github/workflows/wallet-report.yml   # the GitHub Action
├── index.js                              # the script that builds the report
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
