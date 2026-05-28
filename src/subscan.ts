import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SubscanContractInfo {
	address: string;
	isVerified: boolean;
	verifyStatus?: string;
	verifyType?: string;
	verifySource?: string;
	compilerVersion?: string;
	evmVersion?: string;
	optimize?: boolean;
	optimizationRuns?: number;
	isPvm?: boolean;
	contractName?: string;
	toolchain?: string;
	verifyTime?: number;
	transactionCount?: number;
	fetchedAt: string;
	detailFetched: boolean;
}

export interface SubscanOptions {
	baseUrl: string;
	apiKey?: string;
	cachePath: string;
	detailed: boolean;
	sleepMs: number;
	pageSize: number;
}

export function makeSubscanOptions(o: Partial<SubscanOptions> & { baseUrl: string; cachePath: string }): SubscanOptions {
	return {
		baseUrl: o.baseUrl.replace(/\/$/, ''),
		apiKey: o.apiKey,
		cachePath: o.cachePath,
		detailed: o.detailed ?? false,
		sleepMs: o.sleepMs ?? 250,
		pageSize: o.pageSize ?? 100,
	};
}

interface CacheFile {
	[host: string]: {
		addresses: Record<string, SubscanContractInfo>;
		lastListAt?: string;
	};
}

function loadCache(path: string): CacheFile {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
	} catch {
		return {};
	}
}

function saveCache(path: string, cache: CacheFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache, null, 2));
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

function hostKey(baseUrl: string): string {
	try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

async function subscanPost(opts: SubscanOptions, path: string, body: any): Promise<any> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts.apiKey) headers['x-api-key'] = opts.apiKey;

	const url = `${opts.baseUrl}${path}`;
	let attempt = 0;
	while (true) {
		attempt++;
		const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
		if (res.status === 429 && attempt <= 3) {
			const retryAfter = parseInt(res.headers.get('retry-after') ?? '5', 10);
			console.warn(`  subscan: rate limited, sleeping ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			continue;
		}
		if (!res.ok) {
			throw new Error(`subscan: HTTP ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
		}
		const json = await res.json() as any;
		if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
			throw new Error(`subscan: API error code ${json.code} for ${path}: ${json.message}`);
		}
		return json.data;
	}
}

function distillListItem(item: any): SubscanContractInfo {
	const verifyStatus: string = item.verify_status ?? '';
	const compileSettings = item.CompileSettings ?? null;
	return {
		address: String(item.address ?? '').toLowerCase(),
		contractName: item.contract_name || undefined,
		isVerified: verifyStatus === 'perfect' || verifyStatus === 'partial',
		verifyStatus: verifyStatus || undefined,
		evmVersion: item.evm_version || compileSettings?.evmVersion || undefined,
		optimize: compileSettings?.optimizer?.enabled,
		optimizationRuns: compileSettings?.optimizer?.runs,
		verifyTime: typeof item.verify_time === 'number' ? item.verify_time : undefined,
		transactionCount: typeof item.transaction_count === 'number' ? item.transaction_count : undefined,
		fetchedAt: new Date().toISOString(),
		detailFetched: false,
	};
}

function distillDetail(data: any, prior: SubscanContractInfo | undefined): SubscanContractInfo {
	const verifyStatus: string = data.verify_status ?? '';
	const toolchain = guessToolchainFromSource(data.source_code, data.verify_type);
	return {
		address: String(data.address ?? prior?.address ?? '').toLowerCase(),
		contractName: data.contract_name || prior?.contractName,
		isVerified: verifyStatus === 'perfect' || verifyStatus === 'partial',
		verifyStatus: verifyStatus || prior?.verifyStatus,
		verifyType: data.verify_type || undefined,
		verifySource: data.verify_source || undefined,
		compilerVersion: data.compiler_version || undefined,
		evmVersion: data.evm_version || prior?.evmVersion,
		optimize: typeof data.optimize === 'boolean' ? data.optimize : prior?.optimize,
		optimizationRuns: typeof data.optimization_runs === 'number' ? data.optimization_runs : prior?.optimizationRuns,
		isPvm: typeof data.pvm === 'boolean' ? data.pvm : undefined,
		toolchain,
		verifyTime: typeof data.verify_time === 'number' ? data.verify_time : prior?.verifyTime,
		transactionCount: typeof data.transaction_count === 'number' ? data.transaction_count : prior?.transactionCount,
		fetchedAt: new Date().toISOString(),
		detailFetched: true,
	};
}

// Heuristic: distinguish toolchain from verified source paths and verify_type.
// verify_type "Remix" → remix.
// Otherwise (typically "StandardJson"), inspect file paths in source_code:
//   contracts/...  → hardhat
//   src/... or lib/...  → foundry
function guessToolchainFromSource(srcJson: any, verifyType: string | undefined): string | undefined {
	if (typeof verifyType === 'string' && verifyType.toLowerCase() === 'remix') return 'remix';
	if (typeof srcJson !== 'string' || srcJson.length === 0) return undefined;
	let parsed: any;
	try { parsed = JSON.parse(srcJson); } catch { return undefined; }
	if (!parsed || typeof parsed !== 'object') return undefined;
	const paths = Object.keys(parsed);
	for (const p of paths) {
		if (p.startsWith('contracts/') || p.includes('/contracts/')) return 'hardhat';
	}
	for (const p of paths) {
		if (p.startsWith('src/') || p.startsWith('lib/')) return 'foundry';
	}
	return undefined;
}

async function listVerifiedAll(opts: SubscanOptions, contractType: 'evm' | 'pvm'): Promise<any[]> {
	const collected: any[] = [];
	let page = 0;
	let total = 0;
	while (true) {
		const data = await subscanPost(opts, '/api/scan/evm/contract/list', {
			page,
			row: opts.pageSize,
			verified: true,
			contract_type: contractType,
			order: 'desc',
			order_field: 'verify_time',
		});
		const items: any[] = Array.isArray(data?.list) ? data.list : [];
		total = typeof data?.count === 'number' ? data.count : 0;
		collected.push(...items);
		if (collected.length >= total || items.length === 0) break;
		page++;
		await sleep(opts.sleepMs);
	}
	return collected;
}

async function fetchDetail(opts: SubscanOptions, address: string): Promise<any | null> {
	try {
		return await subscanPost(opts, '/api/scan/evm/contract', { address });
	} catch (e) {
		console.warn(`  subscan detail: ${address}: ${(e as Error).message}`);
		return null;
	}
}

export async function lookupVerified(opts: SubscanOptions): Promise<Map<string, SubscanContractInfo>> {
	const cache = loadCache(opts.cachePath);
	const host = hostKey(opts.baseUrl);
	if (!cache[host]) cache[host] = { addresses: {} };
	const hostCache = cache[host];

	const result = new Map<string, SubscanContractInfo>();

	// Phase 1: list verified EVM contracts (and PVM if any).
	let listed: any[] = [];
	for (const ct of ['evm', 'pvm'] as const) {
		try {
			const items = await listVerifiedAll(opts, ct);
			listed.push(...items);
		} catch (e) {
			console.warn(`  subscan list (${ct}): ${(e as Error).message}`);
		}
	}
	for (const item of listed) {
		const distilled = distillListItem(item);
		if (!distilled.address) continue;
		hostCache.addresses[distilled.address] = {
			...hostCache.addresses[distilled.address],
			...distilled,
			detailFetched: hostCache.addresses[distilled.address]?.detailFetched ?? false,
		};
		result.set(distilled.address, hostCache.addresses[distilled.address]);
	}
	hostCache.lastListAt = new Date().toISOString();

	// Phase 2: optionally fetch detail per verified address.
	if (opts.detailed) {
		const addrs = [...result.keys()].filter(a => !hostCache.addresses[a]?.detailFetched);
		let done = 0;
		for (const addr of addrs) {
			done++;
			const data = await fetchDetail(opts, addr);
			if (data) {
				const merged = distillDetail(data, hostCache.addresses[addr]);
				hostCache.addresses[addr] = merged;
				result.set(addr, merged);
			}
			process.stdout.write(`\r  subscan-detailed: ${done}/${addrs.length}    `);
			if (done < addrs.length) await sleep(opts.sleepMs);
		}
		if (addrs.length > 0) process.stdout.write('\n');
	}

	saveCache(opts.cachePath, cache);
	return result;
}
