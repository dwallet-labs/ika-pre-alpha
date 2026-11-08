// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The program's instruction bytes, account discriminators and seed layouts,
 * read from the program's wire table (`src/wire-tables-data.ts`).
 *
 * Nothing here writes a number out. A consumer that writes `const
 * IX_TRANSFER_OWNERSHIP = 24` makes a claim about the program that no
 * compiler can check, and when the program renumbered its instructions that
 * claim became false in a way that still produced a valid transaction: 24 is
 * another instruction, so the program accepted the byte and ran something
 * else. Account discriminators fail the same way in reverse — a wrong
 * discriminator filters every account out server-side, and an empty result
 * reads exactly like a quiet chain.
 *
 * So every number is resolved by NAME at run time, and a name the table does
 * not have throws instead of returning a default.
 *
 * The table, `wire-tables-data.ts`, holds the entries of the program's own
 * table that this SDK uses. It is plain code, so Node, bun, vitest and a browser bundler all load it.
 * The table was once loaded with `createRequire`, a Node builtin, and a page
 * that imported anything from this package died on load with "Module
 * \"node:module\" has been externalized for browser compatibility", before
 * it rendered anything.
 */
import tables from './wire-tables-data.js';

/** One account's header numbers. `variable` accounts carry no fixed length. */
export interface AccountEntry {
	discriminator: number;
	version: number;
	data_len?: number;
	header_len?: number;
	variable?: boolean;
}

/**
 * One component of a program derived address, in the order the program
 * hashes it.
 *
 * Exactly one of `literal`, `width` and `chunks_of` is set. `literal` is an
 * ASCII tag; `width` is a fixed-length value the caller supplies;
 * `chunks_of` is a variable-length value split into seeds of that many bytes
 * (Solana's per-seed limit is 32). `omitted_when` names the condition under
 * which the program leaves the component out entirely.
 */
export interface SeedComponent {
	name: string;
	literal?: string;
	width?: number;
	chunks_of?: number;
	min_len?: number;
	max_len?: number;
	omitted_when?: string;
}

export interface SeedSchema {
	owner: string;
	components: SeedComponent[];
}

interface WireTables {
	schema_version: number;
	program: string;
	account_header: { discriminator_offset: number; version_offset: number; len: number };
	instructions: Record<string, number>;
	accounts: Record<string, AccountEntry>;
	seed_schemas: Record<string, SeedSchema>;
	events: {
		instruction_tag_le: number[];
		event_authority_seed: string;
		discriminators: Record<string, number>;
	};
}

const wireTables = tables as unknown as WireTables;

/** Where the discriminator and version sit at the front of every account. */
export const accountHeader = wireTables.account_header;

function look<T>(kind: string, map: Record<string, T>, name: string): T {
	const entry = map[name];
	if (entry === undefined) {
		const known = Object.keys(map).sort().join(', ');
		throw new Error(`no ${kind} named ${name} in wire-tables.json. Known ${kind}s: ${known}`);
	}
	return entry;
}

/** The first byte of an instruction's data, by the program's name for it. */
export function instructionByte(name: string): number {
	return look('instruction', wireTables.instructions, name);
}

/**
 * The eight bytes every event starts with. The program emits an event by
 * calling itself, so an event is the data of one inner instruction of the
 * transaction that made it: these bytes, the event's number, its fields.
 */
export const EVENT_INSTRUCTION_TAG = Uint8Array.from(wireTables.events.instruction_tag_le);

/** The number an event's data carries right after the tag, by the program's name for it. */
export function eventDiscriminator(name: string): number {
	return look('event', wireTables.events.discriminators, name);
}

/** Everything the table states about one account type. */
export function accountEntry(name: string): AccountEntry {
	return look('account', wireTables.accounts, name);
}

/** The first byte of an account's data, by the program's name for it. */
export function accountDiscriminator(name: string): number {
	return accountEntry(name).discriminator;
}

/**
 * How long an account of this type is.
 *
 * Throws for a variable-length account, whose length is not a property of
 * the type. `MessageRecord` and `DWalletAttestation` are the two today; each
 * states a `header_len` instead, which `accountEntry` returns.
 */
export function accountDataLen(name: string): number {
	const entry = accountEntry(name);
	if (entry.data_len === undefined) {
		throw new Error(`${name} is variable-length; it has no single data_len`);
	}
	return entry.data_len;
}

/** The seed layout of an account's program derived address. */
export function seedSchema(name: string): SeedSchema {
	return look('seed schema', wireTables.seed_schemas, name);
}
