# revive-metrics

Snapshot tool for `pallet-revive` smart-contract usage on a Substrate chain. Connects to a WSS endpoint, walks the revive storage maps, parses Solidity metadata trailers, scans recent blocks for events + extrinsics, and writes per-chain per-date CSV + JSON reports plus an append-only history log.

The default endpoint is Westend Asset Hub; point at another chain with `--rpc`.

## Setup

```bash
npm install
```

Requires Node 18+.

## Usage

```bash
# default snapshot against Westend Asset Hub (no activity scan)
npm start

# point at another chain
npm start -- --rpc wss://...

# tally activity from the last N blocks (events + extrinsics)
npm start -- --scan-events 2000

# scan an explicit historical block range
npm start -- --from-block 8000000 --to-block 8050000

# sanity-test against a small number of entries
npm start -- --limit 10
```

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--rpc <url>` | `$REVIVE_METRICS_RPC` or Westend AH | WSS endpoint |
| `--scan-events <N>` | `0` (skip) | Walk back N blocks from head, scanning revive events + extrinsics |
| `--from-block <N>` | none | Explicit start of scan window. Pairs with `--to-block` (which defaults to chain head) |
| `--to-block <N>` | head when `--from-block` set | Explicit end of scan window |
| `--no-bytecode` | off | Skip fetching EVM bytecode (no Solidity metadata parsing) |
| `--no-history` | off | Don't append a one-line summary to `history-<chain>.jsonl` |
| `--out <dir>` | `./output` | Output directory |
| `--limit <N>` | none | Cap entries processed (sanity testing) |
| `--subscan-host <url>` | none | Subscan API base URL (e.g. `https://assethub-polkadot.api.subscan.io`). When set, list verified contracts from Subscan and merge into the contracts CSV + summary. |
| `--subscan-detailed` | off | After listing verified contracts, also fetch contract detail per address for compiler version + toolchain heuristic. |
| `SUBSCAN_API_KEY` (env) | none | Subscan API key, sent as `x-api-key`. Optional — public access works at lower rate limits. |

## Output files

Per-run files (overwritten on re-run for the same chain on the same day) live in `--out`, suffixed with `<chain-slug>-<YYYY-MM-DD>`:

| File | Contents |
|---|---|
| `summary-<chain>-<date>.json` | Aggregated stats: language breakdown, solc version distribution, code-size percentiles, activity by language, weight-by-language, daily activity, verification stats (when `--subscan-host` is set), legacy stats, top deployers/callers/contracts |
| `codes-<chain>-<date>.csv` | `code_hash, code_type, owner, refcount, code_len, solc_version, ipfs` — one row per uploaded code |
| `contracts-<chain>-<date>.csv` | `address, code_hash, trie_id` — one row per deployed contract. With `--subscan-host`, six extra columns: `language, verify_status, verify_type, compiler_version, toolchain, contract_name`. |
| `events-<chain>-<date>.csv` | `block, timestamp_iso, method, contract, caller, deployer, beneficiary, code_hash` — every revive event in the scan window |
| `extrinsics-<chain>-<date>.csv` | `block, timestamp_iso, method, signer, contract, code_hash, success, weight_ref_time` — every revive extrinsic in the scan window |
| `activity-<chain>-<date>.csv` | Per-active-contract roll-up: `address, code_hash, language, solc_version, calls, instantiations, emits, terminations, unique_callers, last_active_block, last_active_timestamp_iso` |
| `daily-<chain>-<date>.csv` | Per-UTC-day activity breakdown: counts of calls/instantiations/emits, with language splits per day |
| `legacy-codes-<chain>-<date>.csv`, `legacy-contracts-<chain>-<date>.csv` | Only emitted when `pallet-contracts` is present on the chain. Same shape as the revive equivalents but bucketed as legacy ink! |

Plus an append-only trend log per chain (one line per run, not date-suffixed):

| File | Contents |
|---|---|
| `history-<chain>.jsonl` | Compact JSONL: one snapshot entry per run. Captures inventory + activity aggregates + verification + legacy summary so trend charts can be built without re-scanning. Suppress with `--no-history`. |
| `.subscan-cache.json` | Persistent cache of Subscan list/detail responses. Keyed by host then address. Safe to delete to force re-fetch. Only written when `--subscan-host` is used. |

## How it works

Three phases per run:

1. **Codes (`revive.codeInfoOf`)** — iterates the full storage map. For each entry: code hash, on-chain `BytecodeType` (`Pvm` | `Evm`), owner SS58, refcount, code length. For `Evm` entries it then fetches `revive.pristineCode[hash]` and parses the Solidity CBOR metadata trailer (last 2 bytes = trailer length, preceding bytes = CBOR blob) to extract solc version + IPFS hash if present.
2. **Contracts (`revive.accountInfoOf`)** — pages through the storage map (500 entries per page via `entriesPaged`), filters to the `Contract` variant, records H160 address + code hash + trie ID.
3. **Activity (optional)** — walks the resolved scan window (from `--scan-events`, or `--from-block`/`--to-block`) and at each block fetches `system.events` + the block extrinsics + `timestamp.now` (concurrency 20). For each block:
   - Every `revive.*` event is captured (Instantiated, Called, ContractEmitted, Terminated, …) with positional + field-name extraction of `contract`/`caller`/`deployer`/`beneficiary`/`codeHash`.
   - Every `revive.*` extrinsic is captured. `revive.call` extrinsics are the primary call counter (top-level user calls; the `Called` event only fires for sub-calls in some runtime versions). The signed extrinsic gives us the caller for the unique-callers metric.
   - Per-contract activity (calls, instantiations, emits, terminations, unique callers, last active block) is accumulated and joined against the language bucket.

After all phases, the summary is written and (unless `--no-history`) one line is appended to `history-<chain>.jsonl`.

## Language buckets

`pallet-revive` stores a `BytecodeType` flag on every uploaded code (`CodeInfoOf[hash].code_type`). That flag is the primary signal; the Solidity metadata trailer is the secondary signal for the EVM side.

| Bucket | Meaning |
|---|---|
| `rust` | `BytecodeType::Pvm`. Code targets PolkaVM — in practice ink! today, but raw-Rust-via-PolkaVM is also possible. |
| `solidity_evmWithMetadata` | `BytecodeType::Evm` and the bytecode has a parseable Solidity CBOR trailer. Exact solc version is rolled up in `solcVersionDistribution`. |
| `evm_noMetadata` | `BytecodeType::Evm` with no parseable trailer. Either a Solidity build with `--no-cbor-metadata`, or another EVM language (Vyper, Yul, etc.). |
| `codeNotFound` | Contract account references a `code_hash` that's not in the iterated code set (shouldn't happen on a full snapshot; appears under `--limit`). |

## Trending over time

Each run appends one JSON line to `history-<chain>.jsonl`. Each entry holds the inventory snapshot (codes/contracts by language) and, if a scan window was set, the activity aggregates (`callsByLanguage`, `activeContractsByLanguage`, `instantiationsByLanguage`, `weightByLanguage`, …). To chart Rust-vs-Solidity adoption over time, run periodically (cron, GitHub Actions) with the same `--scan-events` window and read the JSONL with `jq` / pandas / DuckDB.

Example — pull a CSV of "calls landing on Rust contracts vs Solidity contracts" over time:

```bash
jq -r '[.runAt, .activity.callsByLanguage.rust, .activity.callsByLanguage.solidity_evmWithMetadata] | @csv' \
  output/history-westend-asset-hub.jsonl
```

## Verification (Subscan)

`--subscan-host <url>` enables a Subscan client that:

1. Pages through `/api/scan/evm/contract/list` with `verified:true` for both `evm` and `pvm` `contract_type`s. The list of verified contracts is small (Polkadot AH had ~10 verified contracts at the time of writing), so this is one or two requests.
2. With `--subscan-detailed`, additionally fetches `/api/scan/evm/contract` per verified address for the full record: `compiler_version`, `verify_type`, `verify_source`, `optimize`, `optimization_runs`, `pvm` boolean, and the multi-file `source_code` payload.

It then merges this against the on-chain contract list and surfaces:

- `verificationStats.totalKnownVerified` — verified count according to Subscan
- `verificationStats.matchedOnChain` / `matchedEvm` / `matchedPvm` — verified contracts that intersect with the on-chain enumeration
- `verificationStats.byVerifyType` — counts of `StandardJson` vs `SingleFile` vs `Remix`
- `verificationStats.byCompilerVersion` — exact solc strings (e.g. `v0.8.24+commit.e11b9ed9`)
- `verificationStats.byToolchain` — heuristic: `hardhat` if any source path starts with `contracts/`, `foundry` if `src/` or `lib/`, `remix` if `verify_type === Remix`. Falls through to unset for unrecognised layouts.

Results are cached in `<out>/.subscan-cache.json` keyed by host+address. Re-runs only fetch new addresses; delete the cache file to force re-verification of everything.

**Known gap**: Subscan currently exposes this API at `assethub-polkadot.api.subscan.io`. There's no Subscan instance for Westend Asset Hub at the corresponding `westend-asset-hub.api.subscan.io` (returns 404). For Westend AH verification, swap to a Blockscout-backed source or skip `--subscan-host`.

The API key is read from `$SUBSCAN_API_KEY` — never pass it on the command line. Public access (no key) works at a lower rate limit; the client honours `429` + `retry-after` automatically.

## Weight / gas distribution

When the scan window is set, the summary's `activity.weightByLanguage` reports per-language `total`, `mean`, `p50`, `p90`, `max` of `weight.refTime` extracted from `system.ExtrinsicSuccess` events for `revive.call` extrinsics. Units are weight refTime (picoseconds in current Substrate runtimes — divide by 1e12 for seconds, by 1e6 for microseconds). Failed extrinsics are excluded.

The same value also lands per-extrinsic in `extrinsics-<chain>-<date>.csv` as the `weight_ref_time` column.

## Per-UTC-day rollup

`daily-<chain>-<date>.csv` and `summary.activity.dailyActivity` bucket events/extrinsics by the UTC date of their block timestamp. Per day you get total calls/instantiations/emits plus the same numbers split by language bucket. Useful for a quick "which days saw Rust traffic" check without re-scanning.

## Legacy `pallet-contracts`

If the chain also runs the older `pallet-contracts` (legacy ink!), the tool enumerates `contracts.codeInfoOf` and `contracts.contractInfoOf` alongside revive and emits `legacy-codes-<chain>-<date>.csv` plus `legacy-contracts-<chain>-<date>.csv`. The summary gets a top-level `legacyStats` block with counts and code-size percentiles. These are kept entirely separate from the revive totals — different VM, different lifecycle.

## Limitations

- **Toolchain attribution** (Hardhat vs Foundry vs cargo-contract, ink! vs raw Rust) is not on-chain. Use `--subscan-host` for Polkadot AH; for other revive networks you'll need a different verification registry (or a self-hosted Subscan/Blockscout instance).
- **Snapshot inventory + windowed activity** — a run captures current chain state plus whatever block range you asked for. The history log is the trend record; a single run is one data point.
- **Deep historical scans are slow** (one RPC round-trip per block); the public RPC may rate-limit, so running against a local archive node is recommended for wide windows.
- **Sub-call attribution** — the `Called` event (when emitted) lets us count contract-to-contract sub-calls; raw `revive.call` extrinsics only count top-level calls. Both are reported separately in `eventCounts.Called` vs `extrinsicCounts.call`.
