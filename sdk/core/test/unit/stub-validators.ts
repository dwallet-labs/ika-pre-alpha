// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * A stand-in for the client's own call (`call` in `src/grpc/client.ts`), for a
 * test client built without its constructor. Each call goes to a stub
 * validator instead of the transport.
 *
 * `stubs()` gives each validator's stub, the first validator first. A stub
 * has a function per gRPC method, called as grpc-js called a method of a
 * service: with the request object, `{ deadline }` and a callback. The
 * requests and answers are the plain objects with the proto's field names
 * that the client encodes and decodes, so nothing is encoded here.
 */
export function callThroughStubs(stubs: () => any[]) {
	return (index: number, method: string, request: object, deadline: number): Promise<any> =>
		new Promise((resolve, reject) =>
			stubs()[index][method](
				request,
				{ deadline: new Date(deadline) },
				(error: Error | null, response: unknown) => (error ? reject(error) : resolve(response)),
			),
		);
}
