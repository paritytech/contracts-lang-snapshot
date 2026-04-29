import { ApiPromise, WsProvider } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSolidityMetadata } from './solidity-meta.js';

interface CliArgs {
	rpc: string;
	scanEvents: number;
	fetchBytecode: boolean;
	outDir: string;
	limit: number | null;
}

interface CodeRecord {
	codeHash: string;
	codeType: string;
	owner: string;
	refcount: string;
	codeLen: number;
	solcVersion?: string;
	ipfs?: string;
}

interface ContractRecord {
	address: string;
	codeHash: string;
	trieId?: string;
}

interface InstantiationEvent {
	block: number;
	deployer: string;
	contract: string;
}

const DEFAULT_RPC = 'wss://westend-asset-hub-rpc.polkadot.io';

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let rpc = process.env.REVIVE_METRICS_RPC ?? DEFAULT_RPC;
	let scanEvents = 0;
	let fetchBytecode = true;
	let outDir = './output';
	let limit: number | null = null;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		switch (a) {
			case '--rpc': rpc = args[++i]; break;
			case '--scan-events': scanEvents = parseInt(args[++i], 10); break;
			case '--no-bytecode': fetchBytecode = false; break;
			case '--out': outDir = args[++i]; break;
			case '--limit': limit = parseInt(args[++i], 10); break;
			case '--help':
			case '-h':
				printHelp();
				process.exit(0);
			default:
				console.error(`Unknown arg: ${a}`);
				printHelp();
				process.exit(1);
		}
	}
	return { rpc, scanEvents, fetchBytecode, outDir, limit };
}

function printHelp(): void {
	console.log(`revive-metrics — snapshot pallet-revive usage on a Substrate chain

Usage: npm start -- [options]

Options:
  --rpc <url>          WSS endpoint (default: $REVIVE_METRICS_RPC or ${DEFAULT_RPC})
  --scan-events <N>    Scan the last N blocks for revive.Instantiated events (default: 0 = skip)
  --no-bytecode        Skip fetching EVM bytecode (no Solidity metadata parsing)
  --out <dir>          Output directory (default: ./output)
  --limit <N>          Cap entries processed (for sanity testing)
  -h, --help           Show this help

Outputs (in --out, suffixed with -<chain-slug>-<YYYY-MM-DD>):
  summary-<chain>-<date>.json    Aggregated stats: language breakdown, solc versions, contract counts
  codes-<chain>-<date>.csv       One row per uploaded code (hash, type, refcount, solc version)
  contracts-<chain>-<date>.csv   One row per deployed contract (address, code hash)
  events-<chain>-<date>.csv      Recent Instantiated events (only if --scan-events > 0)
`);
}

async function main(): Promise<void> {
	const args = parseArgs();
	mkdirSync(args.outDir, { recursive: true });

	console.log(`connecting to ${args.rpc}...`);
	const provider = new WsProvider(args.rpc);
	const api = await ApiPromise.create({ provider, throwOnConnect: true });

	try {
		const chain = (await api.rpc.system.chain()).toString();
		const nodeVer = (await api.rpc.system.version()).toString();
		console.log(`connected: ${chain} (node ${nodeVer})`);

		if (!api.query.revive) {
			throw new Error(
				`pallet-revive is not present on ${chain}. ` +
				`Try another chain.`
			);
		}

		const suffix = `${slugify(chain)}-${new Date().toISOString().slice(0, 10)}`;

		console.log('\n[1/3] enumerating uploaded codes (revive.codeInfoOf)...');
		const codes = await collectCodes(api, args);
		console.log(`  found ${codes.length} code entries`);
		writeFileSync(join(args.outDir, `codes-${suffix}.csv`), codesToCsv(codes));

		console.log('\n[2/3] enumerating accounts (revive.accountInfoOf)...');
		const contracts = await collectContracts(api, args);
		console.log(`  found ${contracts.length} contract accounts`);
		writeFileSync(join(args.outDir, `contracts-${suffix}.csv`), contractsToCsv(contracts));

		let events: { fromBlock: number; toBlock: number; instantiations: InstantiationEvent[] } | null = null;
		if (args.scanEvents > 0) {
			console.log(`\n[3/3] scanning last ${args.scanEvents} blocks for Instantiated events...`);
			events = await scanInstantiations(api, args.scanEvents);
			writeFileSync(join(args.outDir, `events-${suffix}.csv`), eventsToCsv(events.instantiations));
			console.log(`  found ${events.instantiations.length} instantiations`);
		} else {
			console.log('\n[3/3] skipping event scan (use --scan-events N to enable)');
		}

		const summary = buildSummary(chain, codes, contracts, events);
		writeFileSync(join(args.outDir, `summary-${suffix}.json`), JSON.stringify(summary, null, 2));
		console.log(`\nwrote outputs to ${args.outDir}/ with suffix -${suffix}`);
		console.log('\nSummary');
		console.log(JSON.stringify(summary, null, 2));
	} finally {
		await api.disconnect();
	}
}

async function collectCodes(api: ApiPromise, args: CliArgs): Promise<CodeRecord[]> {
	const entries = await api.query.revive.codeInfoOf.entries();
	const out: CodeRecord[] = [];
	for (const [key, val] of entries) {
		const codeHash = (key.args[0] as any).toHex();
		const v = (val as any).toJSON();
		if (!v) continue;
		const codeType = normalizeEnumVariant(v.codeType ?? v.code_type);
		const codeLen = Number(v.codeLen ?? v.code_len ?? 0);

		const record: CodeRecord = {
			codeHash,
			codeType,
			owner: String(v.owner ?? ''),
			refcount: String(v.refcount ?? '0'),
			codeLen,
		};

		if (args.fetchBytecode && codeType.toLowerCase() === 'evm') {
			try {
				const codeBytes = await api.query.revive.pristineCode(codeHash);
				const bytes = hexToU8a((codeBytes as any).toHex());
				const meta = parseSolidityMetadata(bytes);
				if (meta) {
					record.solcVersion = meta.solcVersion;
					record.ipfs = meta.ipfs;
				}
			} catch (e) {
				console.warn(`  warn: could not fetch bytecode for ${codeHash}: ${(e as Error).message}`);
			}
		}

		out.push(record);
		if (args.limit && out.length >= args.limit) break;
	}
	return out;
}

async function collectContracts(api: ApiPromise, args: CliArgs): Promise<ContractRecord[]> {
	const out: ContractRecord[] = [];
	const pageSize = 500;
	let startKey: string | undefined;

	while (true) {
		const opts: any = { pageSize, args: [] };
		if (startKey) opts.startKey = startKey;
		const page = await api.query.revive.accountInfoOf.entriesPaged(opts);
		if (page.length === 0) break;

		for (const [key, val] of page) {
			const address = (key.args[0] as any).toHex();
			const v = (val as any).toJSON();
			if (!v) continue;
			const at = v.accountType ?? v.account_type;
			if (!at || typeof at !== 'object') continue;

			const variant = Object.keys(at)[0];
			if (variant?.toLowerCase() !== 'contract') continue;

			const payload = at[variant];
			out.push({
				address,
				codeHash: String(payload?.codeHash ?? payload?.code_hash ?? ''),
				trieId: payload?.trieId ?? payload?.trie_id,
			});
			if (args.limit && out.length >= args.limit) break;
		}
		if (args.limit && out.length >= args.limit) break;
		if (page.length < pageSize) break;
		startKey = (page[page.length - 1][0] as any).toHex();
	}

	return out;
}

async function scanInstantiations(
	api: ApiPromise,
	blocks: number,
): Promise<{ fromBlock: number; toBlock: number; instantiations: InstantiationEvent[] }> {
	const head = await api.rpc.chain.getHeader();
	const headNum = head.number.toNumber();
	const fromNum = Math.max(0, headNum - blocks + 1);
	const concurrency = 20;
	const events: InstantiationEvent[] = [];

	for (let start = fromNum; start <= headNum; start += concurrency) {
		const end = Math.min(start + concurrency, headNum + 1);
		const tasks: Promise<InstantiationEvent[]>[] = [];
		for (let n = start; n < end; n++) {
			tasks.push(fetchInstantiationsAt(api, n));
		}
		const results = await Promise.all(tasks);
		for (const r of results) events.push(...r);
		process.stdout.write(`\r  scanned ${Math.min(end - fromNum, blocks)}/${blocks} blocks, ${events.length} instantiations    `);
	}
	process.stdout.write('\n');

	return { fromBlock: fromNum, toBlock: headNum, instantiations: events };
}

async function fetchInstantiationsAt(api: ApiPromise, blockNum: number): Promise<InstantiationEvent[]> {
	const hash = await api.rpc.chain.getBlockHash(blockNum);
	const apiAt = await api.at(hash);
	const records = (await apiAt.query.system.events()) as any;
	const out: InstantiationEvent[] = [];
	for (const r of records) {
		if (r.event?.section === 'revive' && r.event?.method === 'Instantiated') {
			const data = r.event.data;
			out.push({
				block: blockNum,
				deployer: data[0].toHex(),
				contract: data[1].toHex(),
			});
		}
	}
	return out;
}

function normalizeEnumVariant(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const k = Object.keys(value)[0];
		return k ?? 'unknown';
	}
	return 'unknown';
}

function buildSummary(
	chain: string,
	codes: CodeRecord[],
	contracts: ContractRecord[],
	events: { fromBlock: number; toBlock: number; instantiations: InstantiationEvent[] } | null,
): unknown {
	const codesByBytecodeType: Record<string, number> = {};
	const solcVersionDist: Record<string, number> = {};
	let rustCodes = 0;
	let solidityCodes = 0;
	let evmUnknownCodes = 0;

	for (const c of codes) {
		codesByBytecodeType[c.codeType] = (codesByBytecodeType[c.codeType] ?? 0) + 1;
		const t = c.codeType.toLowerCase();
		if (t === 'pvm') {
			rustCodes++;
		} else if (t === 'evm') {
			if (c.solcVersion) {
				solidityCodes++;
				solcVersionDist[c.solcVersion] = (solcVersionDist[c.solcVersion] ?? 0) + 1;
			} else {
				evmUnknownCodes++;
			}
		}
	}

	const codeIndex = new Map<string, CodeRecord>();
	for (const c of codes) codeIndex.set(c.codeHash, c);

	let rustContracts = 0;
	let solidityContracts = 0;
	let evmUnknownContracts = 0;
	let unknownCodeContracts = 0;
	const deployerCounts = new Map<string, number>();

	for (const ct of contracts) {
		const code = codeIndex.get(ct.codeHash);
		if (!code) {
			unknownCodeContracts++;
			continue;
		}
		const t = code.codeType.toLowerCase();
		if (t === 'pvm') rustContracts++;
		else if (t === 'evm') {
			if (code.solcVersion) solidityContracts++;
			else evmUnknownContracts++;
		}
	}

	if (events) {
		for (const e of events.instantiations) {
			deployerCounts.set(e.deployer, (deployerCounts.get(e.deployer) ?? 0) + 1);
		}
	}
	const topDeployers = [...deployerCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([deployer, count]) => ({ deployer, count }));

	return {
		chain,
		generatedAt: new Date().toISOString(),
		codeStats: {
			totalUploaded: codes.length,
			byBytecodeType: codesByBytecodeType,
			byLanguage: {
				rust: rustCodes,
				solidity_evmWithMetadata: solidityCodes,
				evm_noMetadata: evmUnknownCodes,
			},
			solcVersionDistribution: solcVersionDist,
		},
		contractStats: {
			totalDeployed: contracts.length,
			byLanguage: {
				rust: rustContracts,
				solidity_evmWithMetadata: solidityContracts,
				evm_noMetadata: evmUnknownContracts,
				codeNotFound: unknownCodeContracts,
			},
		},
		recentActivity: events
			? {
					fromBlock: events.fromBlock,
					toBlock: events.toBlock,
					instantiationCount: events.instantiations.length,
					topDeployers,
				}
			: null,
		notes: [
			'PVM = bytecode type stored on-chain via CodeInfoOf[hash].code_type. PVM is reported as "rust".',
			'Solidity detection requires the CBOR metadata trailer to be present in EVM bytecode. Contracts compiled with --no-cbor-metadata fall into evm_noMetadata.',
			'Tool/compiler attribution beyond solc version (e.g. Hardhat vs Foundry) requires off-chain verification registries (e.g. Subscan).',
		],
	};
}

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function csvEscape(s: string | number | undefined): string {
	if (s === undefined || s === null) return '';
	const str = String(s);
	if (str.includes(',') || str.includes('"') || str.includes('\n')) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

function codesToCsv(codes: CodeRecord[]): string {
	const header = 'code_hash,code_type,owner,refcount,code_len,solc_version,ipfs';
	const rows = codes.map(c =>
		[c.codeHash, c.codeType, c.owner, c.refcount, c.codeLen, c.solcVersion, c.ipfs].map(csvEscape).join(','),
	);
	return [header, ...rows].join('\n') + '\n';
}

function contractsToCsv(contracts: ContractRecord[]): string {
	const header = 'address,code_hash,trie_id';
	const rows = contracts.map(c => [c.address, c.codeHash, c.trieId].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

function eventsToCsv(events: InstantiationEvent[]): string {
	const header = 'block,deployer,contract';
	const rows = events.map(e => [e.block, e.deployer, e.contract].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

main().catch(err => {
	console.error('FATAL:', err);
	process.exit(1);
});
