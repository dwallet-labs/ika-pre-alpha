// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The cross-check of the chain reads that no network signature covers.
 *
 * Most records the SDK reads carry the network's signature, and the SDK
 * checks it, so the endpoint that serves them cannot forge them. A few reads
 * carry no such signature, and one endpoint alone decides what the SDK sees:
 * a network key's record on a custom network, a holder's encryption key
 * registry entry, and, on Sui, the package the coordinator records as the
 * one to call. For these reads the caller names a second endpoint, run by
 * another provider, and {@link crossCheckedRead} returns the answer only when
 * both endpoints agree.
 *
 * Agreement means the same decoded fields the SDK goes on to use, not the
 * same object bytes: the coordinator's object changes version with every
 * request, and a network key record's epoch field changes every epoch, so two
 * honest endpoints often serve different bytes for the same fields.
 *
 * The cross-check stops one lying endpoint. It does not stop two providers
 * that collude, or a lie both repeat from a shared source.
 */

/**
 * How long {@link crossCheckedRead} waits for both endpoints to answer and
 * agree, counted from the first reads.
 */
export const CROSS_CHECK_WINDOW_MS = 10_000;

/** How long {@link crossCheckedRead} waits between two re-reads. */
export const CROSS_CHECK_RETRY_INTERVAL_MS = 1_000;

/**
 * One endpoint's answer to one read.
 *
 * - `{ position, value }`: the endpoint answered from chain state at
 *   `position` (a Sui object's version, 0 when no object is there; a
 *   Solana slot). `value` is `undefined` when nothing is at the address.
 * - `'behind'`: the endpoint refused a read pinned to a position it has not
 *   reached yet.
 */
export type EndpointAnswer<T> = AnswerAt<T> | 'behind';

/** An endpoint's answer from chain state at `position`. */
export type AnswerAt<T> = { position: bigint; value: T | undefined };

/** The two endpoints of a cross-checked read: 0 is the first, 1 the second. */
export type CrossCheckEndpoint = 0 | 1;

/**
 * The answer of a read both endpoints agree on. Rejects otherwise.
 *
 * `read(endpoint, minPosition)` reads from one endpoint. The first reads go to
 * both endpoints at once, with no minimum. When the answers differ, the
 * endpoint that lags is read again, with the minimum set to the higher of the
 * two positions:
 * - when one endpoint finds nothing and the other finds a value, the one that
 *   found nothing lags (a fresh entry may not have reached it yet);
 * - when both find different values, the one at the lower position lags.
 *
 * A re-read answer replaces the old one only once it is at or past that
 * minimum. The re-reads stop when the answers agree, or when the window ends,
 * and the read is then refused, naming both endpoints. Two different values
 * at the same position are refused at once: one endpoint is lying.
 *
 * Every read is bounded by the time left in the window: the first two reads
 * and each re-read. An endpoint that fails, or does not answer before the
 * window ends, refuses the read, naming that endpoint. A re-read that answers
 * after the window is refused the same way. There is no fallback to the other
 * endpoint's answer alone. When both endpoints find nothing, the answer is
 * `undefined`, and the caller reports it as not found.
 */
export async function crossCheckedRead<T>(params: {
	/** The names of the two endpoints, for the refusal. */
	endpoints: readonly [string, string];
	/** What is read, for the refusal. */
	what: string;
	read: (
		endpoint: CrossCheckEndpoint,
		minPosition: bigint | undefined,
	) => Promise<EndpointAnswer<T>>;
	/** Whether two decoded values are the same. */
	equal: (first: T, second: T) => boolean;
	windowMs?: number;
	retryIntervalMs?: number;
}): Promise<T | undefined> {
	const { endpoints, what, read, equal } = params;
	const windowMs = params.windowMs ?? CROSS_CHECK_WINDOW_MS;
	const retryIntervalMs = params.retryIntervalMs ?? CROSS_CHECK_RETRY_INTERVAL_MS;
	const [firstName, secondName] = endpoints;
	const deadline = Date.now() + windowMs;
	// One read, raced against a timer that ends with the window.
	const readFrom = async (
		endpoint: CrossCheckEndpoint,
		minPosition: bigint | undefined,
	): Promise<EndpointAnswer<T>> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				read(endpoint, minPosition),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`no answer within the ${windowMs} ms window`)),
						deadline - Date.now(),
					);
				}),
			]);
		} catch (error) {
			throw new Error(
				`read the ${what} from ${endpoints[endpoint]}: ` +
					`${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
		}
	};
	const answered = (endpoint: CrossCheckEndpoint, answer: EndpointAnswer<T>): AnswerAt<T> => {
		if (answer === 'behind') {
			throw new Error(
				`${endpoints[endpoint]} refused the ${what} read for a position it has not reached, ` +
					'though none was asked for',
			);
		}
		return answer;
	};
	const [firstAnswer, secondAnswer] = await Promise.all([
		readFrom(0, undefined),
		readFrom(1, undefined),
	]);
	const answers: [AnswerAt<T>, AnswerAt<T>] = [answered(0, firstAnswer), answered(1, secondAnswer)];
	const same = (first: T | undefined, second: T | undefined) =>
		first === undefined || second === undefined ? first === second : equal(first, second);
	for (;;) {
		const [first, second] = answers;
		if (same(first.value, second.value)) {
			return first.value;
		}
		let lagging: CrossCheckEndpoint;
		if (first.value === undefined) {
			lagging = 0;
		} else if (second.value === undefined) {
			lagging = 1;
		} else if (first.position < second.position) {
			lagging = 0;
		} else if (second.position < first.position) {
			lagging = 1;
		} else {
			throw new Error(
				`${firstName} and ${secondName} disagree on the ${what} at the same position; ` +
					'refusing the read',
			);
		}
		if (Date.now() + retryIntervalMs > deadline) {
			throw new Error(
				`${firstName} and ${secondName} still disagree on the ${what} after ${windowMs} ms; ` +
					'refusing the read',
			);
		}
		await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
		const target = first.position > second.position ? first.position : second.position;
		const answer = await readFrom(lagging, target);
		if (answer !== 'behind' && answer.position >= target) {
			answers[lagging] = answer;
		}
	}
}
