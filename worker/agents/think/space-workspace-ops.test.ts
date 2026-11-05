import { describe, expect, it } from 'vitest';
import { isAgentDisconnectError, isDurableObjectResetError } from './space-workspace-ops';

describe('durable object disconnect errors', () => {
	it('retries an isolate that was dropped mid-SQL', () => {
		const error = new Error(
			'SQL query failed: Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
		);
		expect(isDurableObjectResetError(error)).toBe(true);
		expect(isAgentDisconnectError(error)).toBe(true);
	});

	it('does not retry the intentional post-deploy abort', () => {
		const error = new Error('Durable Object reset: Generated app deployment updated');
		expect(isDurableObjectResetError(error)).toBe(false);
		expect(isAgentDisconnectError(error)).toBe(false);
	});

	it('treats a stall abort as a disconnect', () => {
		expect(isAgentDisconnectError(new Error('The model stopped responding before it finished writing.'))).toBe(true);
	});
});
