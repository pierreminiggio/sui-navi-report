# SUI Wallet + NAVI Protocol Report

Generates a JSON report combining:
- Raw wallet coin holdings (via Sui's public GraphQL RPC)
- NAVI Protocol supply/borrow positions + health factor

## Usage (locally)

```bash
npm install
WALLET_ADDRESS=0xYOUR_ADDRESS node index.js
```

Output is written to `output/wallet-report.json`.

## Usage (GitHub Actions)

1. Push this repo to GitHub.
2. Go to the **Actions** tab → **SUI Wallet Report** → **Run workflow**.
3. Enter the wallet address when prompted.
4. Once the run finishes, download the `wallet-report` artifact from the run's summary page — it contains `wallet-report.json`.

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
