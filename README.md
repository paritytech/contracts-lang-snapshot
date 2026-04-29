# revive-metrics

Snapshot tool for `pallet-revive` smart-contract usage on a Substrate chain. Connects to a WSS endpoint, walks the revive storage maps, parses Solidity metadata trailers, and writes per-chain per-date CSV + JSON reports.

The default endpoint is Westend Asset Hub; point at another chain with `--rpc`.

## Setup

```bash
npm install
```

Requires Node 18+.

## Usage

```bash
# default snapshot against Westend Asset Hub
npm start

# point at another chain
npm start -- --rpc wss://...

# also tally Instantiated events from the last N blocks
npm start -- --scan-events 2000

# sanity-test against a small number of entries
npm start -- --limit 10
```

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--rpc <url>` | `$REVIVE_METRICS_RPC` or Westend AH | WSS endpoint |
| `--scan-events <N>` | `0` (skip) | Walk back N blocks tallying `revive.Instantiated` events |
| `--no-bytecode` | off | Skip fetching EVM bytecode (no Solidity metadata parsing) |
| `--out <dir>` | `./output` | Output directory |
| `--limit <N>` | none | Cap entries processed (sanity testing) |

## Output files

Each run writes into `--out`, suffixed with `<chain-slug>-<YYYY-MM-DD>`:

| File | Contents |
|---|---|
| `summary-<chain>-<date>.json` | Aggregated stats: language breakdown, solc version distribution, top deployers |
| `codes-<chain>-<date>.csv` | `code_hash, code_type, owner, refcount, code_len, solc_version, ipfs` — one row per uploaded code |
| `contracts-<chain>-<date>.csv` | `address, code_hash, trie_id` — one row per deployed contract |
| `events-<chain>-<date>.csv` | `block, deployer, contract` — only when `--scan-events > 0` |

Re-running on the same chain on the same day overwrites in place; different chains or different dates accumulate side-by-side.

## How it works

Three phases per run:

1. **Codes (`revive.codeInfoOf`)** — iterates the full storage map. For each entry: code hash, on-chain `BytecodeType` (`Pvm` | `Evm`), owner SS58, refcount, code length. For `Evm` entries it then fetches `revive.pristineCode[hash]` and parses the Solidity CBOR metadata trailer (last 2 bytes = trailer length, preceding bytes = CBOR blob) to extract solc version + IPFS hash if present.
2. **Contracts (`revive.accountInfoOf`)** — pages through the storage map (500 entries per page via `entriesPaged`), filters to the `Contract` variant, records H160 address + code hash + trie ID.
3. **Recent activity (optional, `--scan-events N`)** — walks back N blocks from chain head, fetches `system.events` at each block (concurrency 20), filters for `revive.Instantiated { deployer, contract }`.

Aggregation joins contracts against the code index by `code_hash` to produce the language breakdown.

## Language buckets

`pallet-revive` stores a `BytecodeType` flag on every uploaded code (`CodeInfoOf[hash].code_type`). That flag is the primary signal; the Solidity metadata trailer is the secondary signal for the EVM side.

| Bucket | Meaning |
|---|---|
| `rust` | `BytecodeType::Pvm`. Code targets PolkaVM — in practice ink! today, but raw-Rust-via-PolkaVM is also possible. |
| `solidity_evmWithMetadata` | `BytecodeType::Evm` and the bytecode has a parseable Solidity CBOR trailer. Exact solc version is rolled up in `solcVersionDistribution`. |
| `evm_noMetadata` | `BytecodeType::Evm` with no parseable trailer. Either a Solidity build with `--no-cbor-metadata`, or another EVM language (Vyper, Yul, etc.). |
| `codeNotFound` | Contract account references a `code_hash` that's not in the iterated code set (shouldn't happen on a full snapshot; appears under `--limit`). |

## Limitations

- **Toolchain attribution** (Hardhat vs Foundry vs cargo-contract, ink! vs raw Rust) is not on-chain. Cross-reference against a verification registry like Subscan or Sourcify to enrich.
- **Snapshot only** — current chain state plus a recent event window.
- **Call volume per contract is not indexed** — only `Instantiated` events are tallied. Extend `scanInstantiations` to widen the event filter if you need calls too.
- **Long historical event scans** are slow (one RPC round-trip per block); the public RPC may rate-limit deep scans, so running against a local node is recommended.
