/**
 * A Secrets Store binding is an object with `get()`, not a string. Plain
 * secrets and `.dev.vars` values are already strings. Callers that put the
 * binding into an `Authorization` header or an AI SDK `apiKey` must resolve it
 * first — the SDK rejects a non-string with "API key must be a string".
 */
export async function readBindingSecret(value: unknown): Promise<string> {
	if (typeof value === 'string') return value;
	if (value == null || typeof value !== 'object') return '';

	// Secrets Store bindings are RPC stubs. `'get' in binding` is false — the
	// method only appears when the property is read — and a detached
	// `get.call(binding)` is not a valid RPC call. Invoke it on the stub.
	const binding = value as { get?: () => Promise<unknown> };
	if (typeof binding.get !== 'function') return '';
	try {
		const resolved = await binding.get();
		return typeof resolved === 'string' ? resolved : '';
	} catch (error) {
		console.warn('Failed to read Secrets Store binding', {
			error: error instanceof Error ? error.message : 'unknown',
		});
		return '';
	}
}

/** Platform Cloudflare token: gateway token first, then the account API token. */
export async function readCloudflareApiToken(env: {
	CLOUDFLARE_AI_GATEWAY_TOKEN?: unknown;
	CLOUDFLARE_API_TOKEN?: unknown;
}): Promise<string> {
	const gatewayToken = await readBindingSecret(env.CLOUDFLARE_AI_GATEWAY_TOKEN);
	if (gatewayToken) return gatewayToken;
	return readBindingSecret(env.CLOUDFLARE_API_TOKEN);
}
