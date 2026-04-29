import { decode as cborDecode } from 'cbor-x';

export interface SolidityMetadata {
	solcVersion?: string;
	ipfs?: string;
	bzzr1?: string;
	experimental?: boolean;
	raw: Record<string, unknown>;
}

// Solidity appends a CBOR-encoded metadata blob to the end of bytecode, followed
// by 2 bytes (big-endian) holding the blob's length.
// See: https://docs.soliditylang.org/en/latest/metadata.html
export function parseSolidityMetadata(bytecode: Uint8Array): SolidityMetadata | null {
	if (bytecode.length < 4) return null;

	const trailerLen = (bytecode[bytecode.length - 2] << 8) | bytecode[bytecode.length - 1];
	if (trailerLen === 0 || trailerLen > bytecode.length - 2) return null;

	const cborStart = bytecode.length - 2 - trailerLen;
	const cborBlob = bytecode.subarray(cborStart, bytecode.length - 2);

	let decoded: Record<string, unknown>;
	try {
		decoded = cborDecode(cborBlob) as Record<string, unknown>;
	} catch {
		return null;
	}

	if (!decoded || typeof decoded !== 'object') return null;

	const out: SolidityMetadata = { raw: decoded };

	const solc = decoded.solc;
	if (solc instanceof Uint8Array && solc.length === 3) {
		out.solcVersion = `${solc[0]}.${solc[1]}.${solc[2]}`;
	} else if (typeof solc === 'string') {
		out.solcVersion = solc;
	}

	const ipfs = decoded.ipfs;
	if (ipfs instanceof Uint8Array) {
		out.ipfs = bytesToHex(ipfs);
	}

	const bzzr1 = decoded.bzzr1;
	if (bzzr1 instanceof Uint8Array) {
		out.bzzr1 = bytesToHex(bzzr1);
	}

	if (typeof decoded.experimental === 'boolean') {
		out.experimental = decoded.experimental;
	}

	return out;
}

function bytesToHex(b: Uint8Array): string {
	return '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
