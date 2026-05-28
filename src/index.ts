import { ApiPromise, WsProvider } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSolidityMetadata } from './solidity-meta.js';
import { lookupVerified, makeSubscanOptions, SubscanContractInfo } from './subscan.js';

interface CliArgs {
	rpc: string;
	scanEvents: number;
	fromBlock: number | null;
	toBlock: number | null;
	fetchBytecode: boolean;
	outDir: string;
	limit: number | null;
	appendHistory: boolean;
	subscanHost: string | null;
	subscanDetailed: boolean;
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

interface LegacyCodeRecord {
	codeHash: string;
	owner: string;
	refcount: string;
	codeLen: number;
}

interface LegacyContractRecord {
	address: string;
	codeHash: string;
	trieId?: string;
}

interface ReviveEvent {
	block: number;
	timestamp: number;
	method: string;
	contract?: string;
	caller?: string;
	deployer?: string;
	beneficiary?: string;
	codeHash?: string;
}

interface ReviveExtrinsic {
	block: number;
	timestamp: number;
	method: string;
	signer?: string;
	contract?: string;
	codeHash?: string;
	success: boolean;
	weightRefTime?: string;
}

interface ContractActivity {
	calls: number;
	instantiations: number;
	emits: number;
	terminations: number;
	uniqueCallers: Set<string>;
	lastActiveBlock: number;
	lastActiveTimestamp: number;
}

interface ActivityWindow {
	fromBlock: number;
	toBlock: number;
	fromTimestamp: number;
	toTimestamp: number;
	events: ReviveEvent[];
	extrinsics: ReviveExtrinsic[];
	eventCountsByMethod: Record<string, number>;
	extrinsicCountsByMethod: Record<string, number>;
	perContract: Map<string, ContractActivity>;
	uniqueDeployers: Set<string>;
	uniqueCallers: Set<string>;
}

interface DailyBucket {
	date: string;
	calls: number;
	instantiations: number;
	emits: number;
	callsByLanguage: Record<LangBucket, number>;
	instantiationsByLanguage: Record<LangBucket, number>;
	emitsByLanguage: Record<LangBucket, number>;
}

type LangBucket = 'rust' | 'solidity_evmWithMetadata' | 'evm_noMetadata' | 'codeNotFound';

const DEFAULT_RPC = 'wss://westend-asset-hub-rpc.polkadot.io';

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let rpc = process.env.REVIVE_METRICS_RPC ?? DEFAULT_RPC;
	let scanEvents = 0;
	let fromBlock: number | null = null;
	let toBlock: number | null = null;
	let fetchBytecode = true;
	let outDir = './output';
	let limit: number | null = null;
	let appendHistory = true;
	let subscanHost: string | null = null;
	let subscanDetailed = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		switch (a) {
			case '--rpc': rpc = args[++i]; break;
			case '--scan-events': scanEvents = parseInt(args[++i], 10); break;
			case '--from-block': fromBlock = parseInt(args[++i], 10); break;
			case '--to-block': toBlock = parseInt(args[++i], 10); break;
			case '--no-bytecode': fetchBytecode = false; break;
			case '--no-history': appendHistory = false; break;
			case '--out': outDir = args[++i]; break;
			case '--limit': limit = parseInt(args[++i], 10); break;
			case '--subscan-host': subscanHost = args[++i]; break;
			case '--subscan-detailed': subscanDetailed = true; break;
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
	return {
		rpc, scanEvents, fromBlock, toBlock, fetchBytecode, outDir, limit, appendHistory,
		subscanHost, subscanDetailed,
	};
}

function printHelp(): void {
	console.log(`revive-metrics — snapshot pallet-revive usage on a Substrate chain

Usage: npm start -- [options]

Options:
  --rpc <url>                 WSS endpoint (default: $REVIVE_METRICS_RPC or ${DEFAULT_RPC})
  --scan-events <N>           Scan the last N blocks for revive events + extrinsics (default: 0 = skip)
  --from-block <N>            Explicit start of scan window (pairs with --to-block)
  --to-block <N>              Explicit end of scan window (defaults to chain head if --from-block is given)
  --no-bytecode               Skip fetching EVM bytecode (no Solidity metadata parsing)
  --no-history                Don't append a one-line summary to history-<chain>.jsonl
  --out <dir>                 Output directory (default: ./output)
  --limit <N>                 Cap entries processed (for sanity testing)
  --subscan-host <url>        Subscan API base URL (e.g. https://assethub-polkadot.api.subscan.io).
                              When set, list verified contracts and merge into the report.
                              API key is read from $SUBSCAN_API_KEY (optional, public tier works without).
  --subscan-detailed          Also fetch contract detail per verified address (compiler version + toolchain)
  -h, --help                  Show this help

Outputs (in --out, suffixed with -<chain-slug>-<YYYY-MM-DD>):
  summary-<chain>-<date>.json     Aggregated stats
  codes-<chain>-<date>.csv        Revive uploaded codes
  contracts-<chain>-<date>.csv    Revive deployed contracts
  events-<chain>-<date>.csv       Revive events in scan window
  extrinsics-<chain>-<date>.csv   Revive extrinsics in scan window (with weight_ref_time)
  activity-<chain>-<date>.csv     Per-active-contract roll-up over scan window
  daily-<chain>-<date>.csv        Per-UTC-day activity breakdown (with language split)
  legacy-codes-<chain>-<date>.csv,  legacy-contracts-<chain>-<date>.csv
                                   Only when pallet-contracts is present

Per-chain append-only log:
  history-<chain>.jsonl
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
				`Try another chain.`,
			);
		}

		const head = await api.rpc.chain.getHeader();
		const headBlock = head.number.toNumber();
		const chainSlug = slugify(chain);
		const suffix = `${chainSlug}-${new Date().toISOString().slice(0, 10)}`;

		console.log('\n[1/3] enumerating uploaded codes (revive.codeInfoOf)...');
		const codes = await collectCodes(api, args);
		console.log(`  found ${codes.length} code entries`);

		console.log('\n[2/3] enumerating accounts (revive.accountInfoOf)...');
		const contracts = await collectContracts(api, args);
		console.log(`  found ${contracts.length} contract accounts`);

		const codeIndex = buildCodeIndex(codes);

		let subscanMap: Map<string, SubscanContractInfo> | null = null;
		if (args.subscanHost) {
			console.log(`\nsubscan: listing verified contracts at ${args.subscanHost}...`);
			subscanMap = await lookupVerified(makeSubscanOptions({
				baseUrl: args.subscanHost,
				apiKey: process.env.SUBSCAN_API_KEY,
				cachePath: join(args.outDir, '.subscan-cache.json'),
				detailed: args.subscanDetailed,
			}));
			console.log(`  ${subscanMap.size} verified contracts known to Subscan`);
		}

		writeFileSync(join(args.outDir, `codes-${suffix}.csv`), codesToCsv(codes));
		writeFileSync(join(args.outDir, `contracts-${suffix}.csv`), contractsToCsv(contracts, subscanMap, codeIndex));

		const legacyCodes = await collectLegacyCodes(api, args);
		const legacyContracts = await collectLegacyContracts(api, args);
		if (legacyCodes.length > 0 || legacyContracts.length > 0) {
			console.log(`\npallet-contracts: ${legacyCodes.length} codes, ${legacyContracts.length} contracts`);
			writeFileSync(join(args.outDir, `legacy-codes-${suffix}.csv`), legacyCodesToCsv(legacyCodes));
			writeFileSync(join(args.outDir, `legacy-contracts-${suffix}.csv`), legacyContractsToCsv(legacyContracts));
		}

		const window = resolveScanWindow(args, headBlock);
		let activity: ActivityWindow | null = null;
		let dailyBuckets: DailyBucket[] = [];
		if (window) {
			console.log(`\n[3/3] scanning blocks ${window.fromBlock}..${window.toBlock} (${window.toBlock - window.fromBlock + 1} blocks) for revive events + extrinsics...`);
			activity = await scanActivity(api, window.fromBlock, window.toBlock);
			dailyBuckets = computeDailyBuckets(activity, contracts, codeIndex);
			writeFileSync(join(args.outDir, `events-${suffix}.csv`), eventsToCsv(activity.events));
			writeFileSync(join(args.outDir, `extrinsics-${suffix}.csv`), extrinsicsToCsv(activity.extrinsics));
			writeFileSync(join(args.outDir, `activity-${suffix}.csv`), activityToCsv(activity, contracts, codes));
			writeFileSync(join(args.outDir, `daily-${suffix}.csv`), dailyToCsv(dailyBuckets));
			console.log(
				`  scanned ${window.toBlock - window.fromBlock + 1} blocks: ` +
				`${activity.events.length} events, ${activity.extrinsics.length} extrinsics, ` +
				`${activity.perContract.size} contracts touched`,
			);
		} else {
			console.log('\n[3/3] skipping event scan (use --scan-events N or --from-block/--to-block)');
		}

		const summary = buildSummary(
			chain, headBlock, codes, contracts, activity, dailyBuckets,
			legacyCodes, legacyContracts, subscanMap, args,
		);
		writeFileSync(join(args.outDir, `summary-${suffix}.json`), JSON.stringify(summary, null, 2));

		if (args.appendHistory) {
			const historyPath = join(args.outDir, `history-${chainSlug}.jsonl`);
			appendFileSync(historyPath, JSON.stringify(buildHistoryEntry(summary)) + '\n');
			console.log(`\nappended history entry to ${historyPath}`);
		}

		console.log(`\nwrote outputs to ${args.outDir}/ with suffix -${suffix}`);
		console.log('\nSummary');
		console.log(JSON.stringify(summary, null, 2));
	} finally {
		await api.disconnect();
	}
}

function resolveScanWindow(args: CliArgs, headBlock: number): { fromBlock: number; toBlock: number } | null {
	if (args.fromBlock !== null || args.toBlock !== null) {
		const to = args.toBlock ?? headBlock;
		const from = args.fromBlock ?? Math.max(0, to - 1000);
		if (to < from) {
			console.error(`--to-block ${to} is less than --from-block ${from}`);
			process.exit(1);
		}
		if (to > headBlock) {
			console.error(`--to-block ${to} is past chain head ${headBlock}`);
			process.exit(1);
		}
		return { fromBlock: from, toBlock: to };
	}
	if (args.scanEvents > 0) {
		return { fromBlock: Math.max(0, headBlock - args.scanEvents + 1), toBlock: headBlock };
	}
	return null;
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

async function collectLegacyCodes(api: ApiPromise, args: CliArgs): Promise<LegacyCodeRecord[]> {
	const q: any = api.query.contracts;
	if (!q?.codeInfoOf) return [];
	let entries: any[];
	try {
		entries = await q.codeInfoOf.entries();
	} catch (e) {
		console.warn(`  warn: pallet-contracts.codeInfoOf enumeration failed: ${(e as Error).message}`);
		return [];
	}
	const out: LegacyCodeRecord[] = [];
	for (const [key, val] of entries) {
		const codeHash = (key.args[0] as any).toHex();
		const v = (val as any).toJSON?.();
		if (!v) continue;
		out.push({
			codeHash,
			owner: String(v.owner ?? ''),
			refcount: String(v.refcount ?? '0'),
			codeLen: Number(v.codeLen ?? v.code_len ?? 0),
		});
		if (args.limit && out.length >= args.limit) break;
	}
	return out;
}

async function collectLegacyContracts(api: ApiPromise, args: CliArgs): Promise<LegacyContractRecord[]> {
	const q: any = api.query.contracts;
	if (!q?.contractInfoOf) return [];
	const out: LegacyContractRecord[] = [];
	const pageSize = 500;
	let startKey: string | undefined;
	while (true) {
		const opts: any = { pageSize, args: [] };
		if (startKey) opts.startKey = startKey;
		let page: any[];
		try {
			page = await q.contractInfoOf.entriesPaged(opts);
		} catch (e) {
			console.warn(`  warn: pallet-contracts.contractInfoOf enumeration failed: ${(e as Error).message}`);
			break;
		}
		if (page.length === 0) break;
		for (const [key, val] of page) {
			const address = (key.args[0] as any).toString();
			const v = (val as any).toJSON?.();
			if (!v) continue;
			out.push({
				address,
				codeHash: String(v.codeHash ?? v.code_hash ?? ''),
				trieId: v.trieId ?? v.trie_id,
			});
			if (args.limit && out.length >= args.limit) break;
		}
		if (args.limit && out.length >= args.limit) break;
		if (page.length < pageSize) break;
		startKey = (page[page.length - 1][0] as any).toHex();
	}
	return out;
}

async function scanActivity(
	api: ApiPromise,
	fromBlock: number,
	toBlock: number,
): Promise<ActivityWindow> {
	const concurrency = 20;
	const events: ReviveEvent[] = [];
	const extrinsics: ReviveExtrinsic[] = [];
	const eventCountsByMethod: Record<string, number> = {};
	const extrinsicCountsByMethod: Record<string, number> = {};
	const perContract = new Map<string, ContractActivity>();
	const uniqueDeployers = new Set<string>();
	const uniqueCallers = new Set<string>();
	let fromTimestamp = 0;
	let toTimestamp = 0;
	const totalBlocks = toBlock - fromBlock + 1;
	let scanned = 0;

	for (let start = fromBlock; start <= toBlock; start += concurrency) {
		const end = Math.min(start + concurrency - 1, toBlock);
		const tasks: Promise<{ block: number; timestamp: number; events: ReviveEvent[]; extrinsics: ReviveExtrinsic[] }>[] = [];
		for (let n = start; n <= end; n++) {
			tasks.push(fetchBlockActivity(api, n));
		}
		const results = await Promise.all(tasks);
		for (const r of results) {
			if (r.block === fromBlock) fromTimestamp = r.timestamp;
			if (r.block === toBlock) toTimestamp = r.timestamp;
			for (const ev of r.events) {
				events.push(ev);
				eventCountsByMethod[ev.method] = (eventCountsByMethod[ev.method] ?? 0) + 1;
				applyEventToActivity(ev, perContract, uniqueDeployers);
			}
			for (const ext of r.extrinsics) {
				extrinsics.push(ext);
				extrinsicCountsByMethod[ext.method] = (extrinsicCountsByMethod[ext.method] ?? 0) + 1;
				applyExtrinsicToActivity(ext, perContract, uniqueCallers);
			}
		}
		scanned += (end - start + 1);
		process.stdout.write(`\r  scanned ${scanned}/${totalBlocks} blocks, ${events.length} events, ${extrinsics.length} extrinsics    `);
	}
	process.stdout.write('\n');

	return {
		fromBlock,
		toBlock,
		fromTimestamp,
		toTimestamp,
		events,
		extrinsics,
		eventCountsByMethod,
		extrinsicCountsByMethod,
		perContract,
		uniqueDeployers,
		uniqueCallers,
	};
}

async function fetchBlockActivity(
	api: ApiPromise,
	blockNum: number,
): Promise<{ block: number; timestamp: number; events: ReviveEvent[]; extrinsics: ReviveExtrinsic[] }> {
	const hash = await api.rpc.chain.getBlockHash(blockNum);
	const [signedBlock, apiAt] = await Promise.all([
		api.rpc.chain.getBlock(hash),
		api.at(hash),
	]);
	const [records, ts] = await Promise.all([
		apiAt.query.system.events(),
		apiAt.query.timestamp.now(),
	]);
	const tsMs = readU64Number(ts);

	const events: ReviveEvent[] = [];
	const extrinsicSuccessByIndex = new Map<number, boolean>();
	const extrinsicWeightByIndex = new Map<number, string>();

	for (const r of records as any) {
		const phase = r.phase;
		if (phase?.isApplyExtrinsic) {
			const idx = phase.asApplyExtrinsic.toNumber();
			const sec = r.event?.section;
			const meth = r.event?.method;
			if (sec === 'system' && meth === 'ExtrinsicSuccess') {
				extrinsicSuccessByIndex.set(idx, true);
				const weight = readWeightRefTime(r.event?.data?.[0]);
				if (weight !== undefined) extrinsicWeightByIndex.set(idx, weight);
			} else if (sec === 'system' && meth === 'ExtrinsicFailed') {
				extrinsicSuccessByIndex.set(idx, false);
				const weight = readWeightRefTime(r.event?.data?.[1]);
				if (weight !== undefined) extrinsicWeightByIndex.set(idx, weight);
			}
		}
		const ev = r.event;
		if (ev?.section !== 'revive') continue;
		events.push(extractReviveEvent(blockNum, tsMs, ev));
	}

	const extrinsics: ReviveExtrinsic[] = [];
	const exts = (signedBlock as any).block.extrinsics;
	for (let idx = 0; idx < exts.length; idx++) {
		const ext = exts[idx];
		const m = ext.method;
		if (m.section !== 'revive') continue;
		extrinsics.push(extractReviveExtrinsic(
			blockNum, tsMs, idx, ext, extrinsicSuccessByIndex, extrinsicWeightByIndex,
		));
	}

	return { block: blockNum, timestamp: tsMs, events, extrinsics };
}

function readWeightRefTime(dispatchInfo: any): string | undefined {
	if (!dispatchInfo) return undefined;
	try {
		const weight = dispatchInfo.weight ?? dispatchInfo;
		const refTime = weight?.refTime ?? weight?.ref_time ?? weight;
		const big = refTime?.toBigInt?.();
		if (typeof big === 'bigint') return big.toString();
		const str = refTime?.toString?.();
		if (str && /^\d+$/.test(str)) return str;
	} catch { /* ignore */ }
	return undefined;
}

function extractReviveEvent(block: number, timestamp: number, ev: any): ReviveEvent {
	const method = String(ev.method);
	const named = readEventFields(ev);
	const evt: ReviveEvent = {
		block,
		timestamp,
		method,
		contract: pickField(named, ['contract', 'contractAddress', 'address']),
		caller: pickField(named, ['caller', 'origin', 'from']),
		deployer: pickField(named, ['deployer']),
		beneficiary: pickField(named, ['beneficiary', 'to']),
		codeHash: pickField(named, ['codeHash', 'code_hash']),
	};

	const m = method.toLowerCase();
	if (!evt.contract && (m === 'instantiated' || m === 'called' || m === 'contractemitted' || m === 'terminated')) {
		if (m === 'instantiated') {
			evt.deployer = evt.deployer ?? named['arg0'];
			evt.contract = named['arg1'];
		} else if (m === 'called') {
			evt.caller = evt.caller ?? named['arg0'];
			evt.contract = named['arg1'];
		} else if (m === 'contractemitted') {
			evt.contract = named['arg0'];
		} else if (m === 'terminated') {
			evt.contract = named['arg0'];
			evt.beneficiary = evt.beneficiary ?? named['arg1'];
		}
	}
	return evt;
}

function extractReviveExtrinsic(
	block: number,
	timestamp: number,
	index: number,
	ext: any,
	successByIndex: Map<number, boolean>,
	weightByIndex: Map<number, string>,
): ReviveExtrinsic {
	const method = String(ext.method.method);
	const out: ReviveExtrinsic = {
		block,
		timestamp,
		method,
		signer: ext.isSigned ? ext.signer.toString() : undefined,
		success: successByIndex.get(index) ?? true,
		weightRefTime: weightByIndex.get(index),
	};
	const args = ext.method.args ?? [];
	const m = method.toLowerCase();
	if (m === 'call' && args[0]) {
		out.contract = safeToHex(args[0]);
	} else if ((m === 'upload_code' || m === 'remove_code' || m === 'set_code') && args[0]) {
		out.codeHash = safeToHex(args[0]);
	}
	return out;
}

function applyEventToActivity(
	ev: ReviveEvent,
	perContract: Map<string, ContractActivity>,
	uniqueDeployers: Set<string>,
): void {
	if (ev.deployer) uniqueDeployers.add(ev.deployer.toLowerCase());
	const target = ev.contract;
	if (!target) return;
	const a = ensureContractActivity(perContract, target);
	if (ev.block > a.lastActiveBlock) {
		a.lastActiveBlock = ev.block;
		a.lastActiveTimestamp = ev.timestamp;
	}
	const m = ev.method.toLowerCase();
	if (m === 'called') a.calls++;
	else if (m === 'instantiated') a.instantiations++;
	else if (m === 'contractemitted') a.emits++;
	else if (m === 'terminated') a.terminations++;
	if (ev.caller) a.uniqueCallers.add(ev.caller.toLowerCase());
}

function applyExtrinsicToActivity(
	ext: ReviveExtrinsic,
	perContract: Map<string, ContractActivity>,
	uniqueCallers: Set<string>,
): void {
	if (!ext.success) return;
	if (ext.signer) uniqueCallers.add(ext.signer.toLowerCase());
	const m = ext.method.toLowerCase();
	if (m === 'call' && ext.contract) {
		const a = ensureContractActivity(perContract, ext.contract);
		a.calls++;
		if (ext.signer) a.uniqueCallers.add(ext.signer.toLowerCase());
		if (ext.block > a.lastActiveBlock) {
			a.lastActiveBlock = ext.block;
			a.lastActiveTimestamp = ext.timestamp;
		}
	}
}

function ensureContractActivity(map: Map<string, ContractActivity>, address: string): ContractActivity {
	const key = address.toLowerCase();
	let a = map.get(key);
	if (!a) {
		a = {
			calls: 0,
			instantiations: 0,
			emits: 0,
			terminations: 0,
			uniqueCallers: new Set(),
			lastActiveBlock: 0,
			lastActiveTimestamp: 0,
		};
		map.set(key, a);
	}
	return a;
}

function readEventFields(ev: any): Record<string, string> {
	const out: Record<string, string> = {};
	const data = ev.data;
	let names: string[] = [];
	const dataNames = (data as any).names;
	if (Array.isArray(dataNames)) {
		names = dataNames.map((n: any) => String(n ?? ''));
	} else if (ev.meta?.fields) {
		try {
			names = ev.meta.fields.map((f: any) => {
				const n = f.name;
				if (!n) return '';
				try { return (n.isSome ? n.unwrap() : n).toString(); }
				catch { return n.toString?.() ?? ''; }
			});
		} catch { names = []; }
	}
	for (let i = 0; i < data.length; i++) {
		const k = names[i] || `arg${i}`;
		out[k] = safeToHex(data[i]);
	}
	return out;
}

function pickField(named: Record<string, string>, candidates: string[]): string | undefined {
	for (const c of candidates) {
		if (c in named && named[c]) return named[c];
	}
	return undefined;
}

function safeToHex(v: any): string {
	if (v == null) return '';
	try { return v.toHex(); } catch { /* fall through */ }
	try { return v.toString(); } catch { return ''; }
}

function readU64Number(v: any): number {
	try {
		const big = v.toBigInt?.();
		if (typeof big === 'bigint') return Number(big);
	} catch { /* fall through */ }
	try { return v.toNumber?.() ?? 0; } catch { return 0; }
}

function normalizeEnumVariant(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const k = Object.keys(value)[0];
		return k ?? 'unknown';
	}
	return 'unknown';
}

function buildCodeIndex(codes: CodeRecord[]): Map<string, CodeRecord> {
	const idx = new Map<string, CodeRecord>();
	for (const c of codes) idx.set(c.codeHash, c);
	return idx;
}

function languageFor(ct: ContractRecord | undefined, codeIndex: Map<string, CodeRecord>): LangBucket {
	if (!ct) return 'codeNotFound';
	const code = codeIndex.get(ct.codeHash);
	if (!code) return 'codeNotFound';
	const t = code.codeType.toLowerCase();
	if (t === 'pvm') return 'rust';
	if (t === 'evm') return code.solcVersion ? 'solidity_evmWithMetadata' : 'evm_noMetadata';
	return 'codeNotFound';
}

function emptyLangBuckets(): Record<LangBucket, number> {
	return { rust: 0, solidity_evmWithMetadata: 0, evm_noMetadata: 0, codeNotFound: 0 };
}

function percentilesFromNumbers(values: number[]): { p50: number; p90: number; p99: number; max: number; mean: number; count: number } {
	if (values.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0, mean: 0, count: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((s, v) => s + v, 0);
	return {
		p50: sorted[Math.floor(sorted.length * 0.5)],
		p90: sorted[Math.floor(sorted.length * 0.9)],
		p99: sorted[Math.floor(sorted.length * 0.99)],
		max: sorted[sorted.length - 1],
		mean: Math.round(sum / sorted.length),
		count: sorted.length,
	};
}

function percentilesFromBigInts(values: bigint[]): { total: string; mean: string; p50: string; p90: string; max: string; count: number } {
	if (values.length === 0) return { total: '0', mean: '0', p50: '0', p90: '0', max: '0', count: 0 };
	const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const total = sorted.reduce((s, v) => s + v, 0n);
	return {
		total: total.toString(),
		mean: (total / BigInt(sorted.length)).toString(),
		p50: sorted[Math.floor(sorted.length * 0.5)].toString(),
		p90: sorted[Math.floor(sorted.length * 0.9)].toString(),
		max: sorted[sorted.length - 1].toString(),
		count: sorted.length,
	};
}

function computeCodeSizeStats(codes: CodeRecord[]): Record<string, ReturnType<typeof percentilesFromNumbers>> {
	const buckets: Record<string, number[]> = {
		rust: [],
		solidity_evmWithMetadata: [],
		evm_noMetadata: [],
	};
	for (const c of codes) {
		const t = c.codeType.toLowerCase();
		if (t === 'pvm') buckets.rust.push(c.codeLen);
		else if (t === 'evm') {
			if (c.solcVersion) buckets.solidity_evmWithMetadata.push(c.codeLen);
			else buckets.evm_noMetadata.push(c.codeLen);
		}
	}
	const out: Record<string, ReturnType<typeof percentilesFromNumbers>> = {};
	for (const [k, arr] of Object.entries(buckets)) {
		out[k] = percentilesFromNumbers(arr);
	}
	return out;
}

function computeWeightStats(
	extrinsics: ReviveExtrinsic[],
	contractByAddr: Map<string, ContractRecord>,
	codeIndex: Map<string, CodeRecord>,
): Record<LangBucket, ReturnType<typeof percentilesFromBigInts>> {
	const buckets: Record<LangBucket, bigint[]> = {
		rust: [], solidity_evmWithMetadata: [], evm_noMetadata: [], codeNotFound: [],
	};
	for (const x of extrinsics) {
		if (!x.success) continue;
		if (x.method.toLowerCase() !== 'call') continue;
		if (!x.contract || !x.weightRefTime) continue;
		const ct = contractByAddr.get(x.contract.toLowerCase());
		const lang = languageFor(ct, codeIndex);
		try { buckets[lang].push(BigInt(x.weightRefTime)); }
		catch { /* ignore */ }
	}
	const out: any = {};
	for (const [k, arr] of Object.entries(buckets)) {
		out[k] = percentilesFromBigInts(arr);
	}
	return out;
}

function computeDailyBuckets(
	activity: ActivityWindow,
	contracts: ContractRecord[],
	codeIndex: Map<string, CodeRecord>,
): DailyBucket[] {
	const contractByAddr = new Map<string, ContractRecord>();
	for (const c of contracts) contractByAddr.set(c.address.toLowerCase(), c);
	const map = new Map<string, DailyBucket>();
	const ensure = (day: string): DailyBucket => {
		let b = map.get(day);
		if (!b) {
			b = {
				date: day,
				calls: 0,
				instantiations: 0,
				emits: 0,
				callsByLanguage: emptyLangBuckets(),
				instantiationsByLanguage: emptyLangBuckets(),
				emitsByLanguage: emptyLangBuckets(),
			};
			map.set(day, b);
		}
		return b;
	};

	for (const e of activity.events) {
		if (!e.timestamp) continue;
		const day = new Date(e.timestamp).toISOString().slice(0, 10);
		const b = ensure(day);
		const ct = e.contract ? contractByAddr.get(e.contract.toLowerCase()) : undefined;
		const lang = languageFor(ct, codeIndex);
		const m = e.method.toLowerCase();
		if (m === 'instantiated') { b.instantiations++; b.instantiationsByLanguage[lang]++; }
		else if (m === 'contractemitted') { b.emits++; b.emitsByLanguage[lang]++; }
	}

	for (const x of activity.extrinsics) {
		if (!x.timestamp) continue;
		if (!x.success) continue;
		if (x.method.toLowerCase() !== 'call' || !x.contract) continue;
		const day = new Date(x.timestamp).toISOString().slice(0, 10);
		const b = ensure(day);
		const ct = contractByAddr.get(x.contract.toLowerCase());
		const lang = languageFor(ct, codeIndex);
		b.calls++;
		b.callsByLanguage[lang]++;
	}

	return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildVerificationStats(
	contracts: ContractRecord[],
	subscanMap: Map<string, SubscanContractInfo> | null,
	codeIndex: Map<string, CodeRecord>,
	args: CliArgs,
): any {
	if (!subscanMap) return null;
	const stats = {
		source: 'subscan',
		host: args.subscanHost,
		detailed: args.subscanDetailed,
		totalKnownVerified: subscanMap.size,
		matchedOnChain: 0,
		matchedEvm: 0,
		matchedPvm: 0,
		matchedUnknownCode: 0,
		perfect: 0,
		partial: 0,
		byVerifyType: {} as Record<string, number>,
		byCompilerVersion: {} as Record<string, number>,
		byToolchain: {} as Record<string, number>,
	};
	const onChainSet = new Set(contracts.map(c => c.address.toLowerCase()));
	for (const [addr, info] of subscanMap) {
		if (!onChainSet.has(addr)) continue;
		stats.matchedOnChain++;
		const ct = contracts.find(c => c.address.toLowerCase() === addr);
		const code = ct ? codeIndex.get(ct.codeHash) : undefined;
		if (!code) stats.matchedUnknownCode++;
		else if (code.codeType.toLowerCase() === 'evm') stats.matchedEvm++;
		else if (code.codeType.toLowerCase() === 'pvm') stats.matchedPvm++;

		if (info.verifyStatus === 'perfect') stats.perfect++;
		else if (info.verifyStatus === 'partial') stats.partial++;
		if (info.verifyType) stats.byVerifyType[info.verifyType] = (stats.byVerifyType[info.verifyType] ?? 0) + 1;
		if (info.compilerVersion) stats.byCompilerVersion[info.compilerVersion] = (stats.byCompilerVersion[info.compilerVersion] ?? 0) + 1;
		if (info.toolchain) stats.byToolchain[info.toolchain] = (stats.byToolchain[info.toolchain] ?? 0) + 1;
	}
	return stats;
}

function buildLegacyStats(legacyCodes: LegacyCodeRecord[], legacyContracts: LegacyContractRecord[]): any {
	if (legacyCodes.length === 0 && legacyContracts.length === 0) return null;
	const codeSize = percentilesFromNumbers(legacyCodes.map(c => c.codeLen));
	const totalBytes = legacyCodes.reduce((s, c) => s + c.codeLen, 0);
	return {
		palletPresent: true,
		codes: legacyCodes.length,
		contracts: legacyContracts.length,
		totalCodeBytes: totalBytes,
		codeSize,
	};
}

function buildSummary(
	chain: string,
	headBlock: number,
	codes: CodeRecord[],
	contracts: ContractRecord[],
	activity: ActivityWindow | null,
	dailyBuckets: DailyBucket[],
	legacyCodes: LegacyCodeRecord[],
	legacyContracts: LegacyContractRecord[],
	subscanMap: Map<string, SubscanContractInfo> | null,
	args: CliArgs,
): any {
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

	const codeIndex = buildCodeIndex(codes);

	const contractByAddr = new Map<string, ContractRecord>();
	const contractsByLanguage = emptyLangBuckets();
	for (const ct of contracts) {
		contractByAddr.set(ct.address.toLowerCase(), ct);
		contractsByLanguage[languageFor(ct, codeIndex)]++;
	}

	const codeSizeStats = computeCodeSizeStats(codes);

	let activityStats: any = null;
	if (activity) {
		const callsByLanguage = emptyLangBuckets();
		const instantiationsByLanguage = emptyLangBuckets();
		const emitsByLanguage = emptyLangBuckets();
		const activeContractsByLanguage = emptyLangBuckets();

		for (const [addr, a] of activity.perContract) {
			const ct = contractByAddr.get(addr);
			const lang = languageFor(ct, codeIndex);
			callsByLanguage[lang] += a.calls;
			instantiationsByLanguage[lang] += a.instantiations;
			emitsByLanguage[lang] += a.emits;
			activeContractsByLanguage[lang]++;
		}

		const deployerCounts = new Map<string, number>();
		for (const e of activity.events) {
			if (e.method === 'Instantiated' && e.deployer) {
				deployerCounts.set(e.deployer, (deployerCounts.get(e.deployer) ?? 0) + 1);
			}
		}
		const callerCounts = new Map<string, number>();
		for (const x of activity.extrinsics) {
			if (x.method.toLowerCase() === 'call' && x.signer) {
				callerCounts.set(x.signer, (callerCounts.get(x.signer) ?? 0) + 1);
			}
		}
		const topDeployers = [...deployerCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([deployer, count]) => ({ deployer, count }));
		const topCallers = [...callerCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([caller, count]) => ({ caller, count }));
		const topContracts = [...activity.perContract.entries()]
			.sort((a, b) => b[1].calls - a[1].calls)
			.slice(0, 10)
			.map(([address, a]) => {
				const ct = contractByAddr.get(address);
				return {
					address,
					language: languageFor(ct, codeIndex),
					calls: a.calls,
					emits: a.emits,
					uniqueCallers: a.uniqueCallers.size,
				};
			});

		const weightByLanguage = computeWeightStats(activity.extrinsics, contractByAddr, codeIndex);

		activityStats = {
			fromBlock: activity.fromBlock,
			toBlock: activity.toBlock,
			fromTimestamp: activity.fromTimestamp ? new Date(activity.fromTimestamp).toISOString() : null,
			toTimestamp: activity.toTimestamp ? new Date(activity.toTimestamp).toISOString() : null,
			eventCounts: activity.eventCountsByMethod,
			extrinsicCounts: activity.extrinsicCountsByMethod,
			totalEvents: activity.events.length,
			totalExtrinsics: activity.extrinsics.length,
			uniqueDeployers: activity.uniqueDeployers.size,
			uniqueCallers: activity.uniqueCallers.size,
			activeContracts: activity.perContract.size,
			activeContractsByLanguage,
			callsByLanguage,
			instantiationsByLanguage,
			emitsByLanguage,
			weightByLanguage,
			dailyActivity: dailyBuckets,
			topDeployers,
			topCallers,
			topContracts,
		};
	}

	return {
		chain,
		generatedAt: new Date().toISOString(),
		headBlock,
		codeStats: {
			totalUploaded: codes.length,
			byBytecodeType: codesByBytecodeType,
			byLanguage: {
				rust: rustCodes,
				solidity_evmWithMetadata: solidityCodes,
				evm_noMetadata: evmUnknownCodes,
			},
			solcVersionDistribution: solcVersionDist,
			codeSizeStats,
		},
		contractStats: {
			totalDeployed: contracts.length,
			byLanguage: contractsByLanguage,
		},
		activity: activityStats,
		verificationStats: buildVerificationStats(contracts, subscanMap, codeIndex, args),
		legacyStats: buildLegacyStats(legacyCodes, legacyContracts),
		notes: [
			'PVM = bytecode type stored on-chain via CodeInfoOf[hash].code_type. PVM is reported as "rust".',
			'Solidity detection requires the CBOR metadata trailer to be present in EVM bytecode. Contracts compiled with --no-cbor-metadata fall into evm_noMetadata.',
			'Toolchain attribution comes from --subscan-host with --subscan-detailed: Hardhat vs Foundry inferred from verified source paths (contracts/ vs src/, lib/), Remix from verify_type.',
			'Activity reflects only the scanned block window. Trend over time via the appended history-<chain>.jsonl.',
			'callsByLanguage is driven primarily by revive.call extrinsics (top-level calls). The Called event count covers sub-calls if the runtime emits it.',
			'weightByLanguage units are weight refTime (picoseconds in current Substrate runtimes); divide by 1e12 for seconds.',
			'legacyStats covers pallet-contracts (legacy ink!) when the pallet is present. Counted separately from revive.',
		],
	};
}

function buildHistoryEntry(summary: any): any {
	return {
		runAt: summary.generatedAt,
		chain: summary.chain,
		headBlock: summary.headBlock,
		codes: {
			total: summary.codeStats.totalUploaded,
			...summary.codeStats.byLanguage,
		},
		contracts: {
			total: summary.contractStats.totalDeployed,
			...summary.contractStats.byLanguage,
		},
		codeSizeStats: summary.codeStats.codeSizeStats,
		activity: summary.activity ? {
			fromBlock: summary.activity.fromBlock,
			toBlock: summary.activity.toBlock,
			fromTimestamp: summary.activity.fromTimestamp,
			toTimestamp: summary.activity.toTimestamp,
			totalEvents: summary.activity.totalEvents,
			totalExtrinsics: summary.activity.totalExtrinsics,
			eventCounts: summary.activity.eventCounts,
			extrinsicCounts: summary.activity.extrinsicCounts,
			activeContracts: summary.activity.activeContracts,
			activeContractsByLanguage: summary.activity.activeContractsByLanguage,
			callsByLanguage: summary.activity.callsByLanguage,
			instantiationsByLanguage: summary.activity.instantiationsByLanguage,
			emitsByLanguage: summary.activity.emitsByLanguage,
			weightByLanguage: summary.activity.weightByLanguage,
			uniqueDeployers: summary.activity.uniqueDeployers,
			uniqueCallers: summary.activity.uniqueCallers,
			daysCovered: Array.isArray(summary.activity.dailyActivity) ? summary.activity.dailyActivity.length : 0,
		} : null,
		verification: summary.verificationStats ? {
			source: summary.verificationStats.source,
			host: summary.verificationStats.host,
			totalKnownVerified: summary.verificationStats.totalKnownVerified,
			matchedOnChain: summary.verificationStats.matchedOnChain,
			matchedEvm: summary.verificationStats.matchedEvm,
			matchedPvm: summary.verificationStats.matchedPvm,
			perfect: summary.verificationStats.perfect,
			partial: summary.verificationStats.partial,
			byToolchain: summary.verificationStats.byToolchain,
			byCompilerVersion: summary.verificationStats.byCompilerVersion,
		} : null,
		legacy: summary.legacyStats ? {
			codes: summary.legacyStats.codes,
			contracts: summary.legacyStats.contracts,
			totalCodeBytes: summary.legacyStats.totalCodeBytes,
		} : null,
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

function contractsToCsv(
	contracts: ContractRecord[],
	subscanMap: Map<string, SubscanContractInfo> | null,
	codeIndex: Map<string, CodeRecord>,
): string {
	if (!subscanMap) {
		const header = 'address,code_hash,trie_id';
		const rows = contracts.map(c => [c.address, c.codeHash, c.trieId].map(csvEscape).join(','));
		return [header, ...rows].join('\n') + '\n';
	}
	const header = 'address,code_hash,trie_id,language,verify_status,verify_type,compiler_version,toolchain,contract_name';
	const rows = contracts.map(c => {
		const lang = languageFor(c, codeIndex);
		const info = subscanMap.get(c.address.toLowerCase());
		return [
			c.address,
			c.codeHash,
			c.trieId,
			lang,
			info?.verifyStatus ?? '',
			info?.verifyType ?? '',
			info?.compilerVersion ?? '',
			info?.toolchain ?? '',
			info?.contractName ?? '',
		].map(csvEscape).join(',');
	});
	return [header, ...rows].join('\n') + '\n';
}

function legacyCodesToCsv(codes: LegacyCodeRecord[]): string {
	const header = 'code_hash,owner,refcount,code_len';
	const rows = codes.map(c => [c.codeHash, c.owner, c.refcount, c.codeLen].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

function legacyContractsToCsv(contracts: LegacyContractRecord[]): string {
	const header = 'address,code_hash,trie_id';
	const rows = contracts.map(c => [c.address, c.codeHash, c.trieId].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

function eventsToCsv(events: ReviveEvent[]): string {
	const header = 'block,timestamp_iso,method,contract,caller,deployer,beneficiary,code_hash';
	const rows = events.map(e => [
		e.block,
		e.timestamp ? new Date(e.timestamp).toISOString() : '',
		e.method,
		e.contract ?? '',
		e.caller ?? '',
		e.deployer ?? '',
		e.beneficiary ?? '',
		e.codeHash ?? '',
	].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

function extrinsicsToCsv(extrinsics: ReviveExtrinsic[]): string {
	const header = 'block,timestamp_iso,method,signer,contract,code_hash,success,weight_ref_time';
	const rows = extrinsics.map(x => [
		x.block,
		x.timestamp ? new Date(x.timestamp).toISOString() : '',
		x.method,
		x.signer ?? '',
		x.contract ?? '',
		x.codeHash ?? '',
		x.success ? 'true' : 'false',
		x.weightRefTime ?? '',
	].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

function activityToCsv(
	activity: ActivityWindow,
	contracts: ContractRecord[],
	codes: CodeRecord[],
): string {
	const codeIndex = buildCodeIndex(codes);
	const contractByAddr = new Map<string, ContractRecord>();
	for (const c of contracts) contractByAddr.set(c.address.toLowerCase(), c);
	const header = 'address,code_hash,language,solc_version,calls,instantiations,emits,terminations,unique_callers,last_active_block,last_active_timestamp_iso';
	const rows: string[] = [];
	for (const [addr, a] of activity.perContract) {
		const ct = contractByAddr.get(addr);
		const code = ct ? codeIndex.get(ct.codeHash) : undefined;
		const lang = languageFor(ct, codeIndex);
		rows.push([
			addr,
			ct?.codeHash ?? '',
			lang,
			code?.solcVersion ?? '',
			a.calls,
			a.instantiations,
			a.emits,
			a.terminations,
			a.uniqueCallers.size,
			a.lastActiveBlock,
			a.lastActiveTimestamp ? new Date(a.lastActiveTimestamp).toISOString() : '',
		].map(csvEscape).join(','));
	}
	return [header, ...rows].join('\n') + '\n';
}

function dailyToCsv(buckets: DailyBucket[]): string {
	const header = [
		'date',
		'calls', 'instantiations', 'emits',
		'calls_rust', 'calls_solidity_evm_with_metadata', 'calls_evm_no_metadata', 'calls_code_not_found',
		'inst_rust', 'inst_solidity_evm_with_metadata', 'inst_evm_no_metadata', 'inst_code_not_found',
		'emits_rust', 'emits_solidity_evm_with_metadata', 'emits_evm_no_metadata', 'emits_code_not_found',
	].join(',');
	const rows = buckets.map(b => [
		b.date,
		b.calls, b.instantiations, b.emits,
		b.callsByLanguage.rust, b.callsByLanguage.solidity_evmWithMetadata, b.callsByLanguage.evm_noMetadata, b.callsByLanguage.codeNotFound,
		b.instantiationsByLanguage.rust, b.instantiationsByLanguage.solidity_evmWithMetadata, b.instantiationsByLanguage.evm_noMetadata, b.instantiationsByLanguage.codeNotFound,
		b.emitsByLanguage.rust, b.emitsByLanguage.solidity_evmWithMetadata, b.emitsByLanguage.evm_noMetadata, b.emitsByLanguage.codeNotFound,
	].map(csvEscape).join(','));
	return [header, ...rows].join('\n') + '\n';
}

main().catch(err => {
	console.error('FATAL:', err);
	process.exit(1);
});
