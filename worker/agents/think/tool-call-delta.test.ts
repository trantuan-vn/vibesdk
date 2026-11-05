import { describe, expect, it } from 'vitest';
import { ensureToolCallFunction, jsonCloser, rewriteToolCallSse } from './tool-call-delta';

function patch(json: Record<string, unknown>): void {
	const choices = json.choices;
	if (!Array.isArray(choices)) return;
	for (const choice of choices) {
		const toolCalls = (choice as { delta?: { tool_calls?: unknown[] } }).delta?.tool_calls;
		toolCalls?.forEach((call, i) => {
			if (call && typeof call === 'object' && (call as { index?: unknown }).index == null) {
				(call as { index: number }).index = i;
			}
			ensureToolCallFunction(call);
		});
	}
}

describe('ensureToolCallFunction', () => {
	it('adds an empty function when DeepSeek omits it', () => {
		const call: { index: number; function?: { arguments: string } } = { index: 0 };
		ensureToolCallFunction(call);
		expect(call.function).toEqual({ arguments: '' });
	});

	it('keeps a real function name and arguments', () => {
		const call = { index: 0, function: { name: 'write', arguments: '{"path":' } };
		ensureToolCallFunction(call);
		expect(call.function).toEqual({ name: 'write', arguments: '{"path":' });
	});

	it('coerces a missing arguments field to an empty string', () => {
		const call = { index: 0, function: { name: 'write' } };
		ensureToolCallFunction(call);
		expect(call.function).toEqual({ name: 'write', arguments: '' });
	});

	it('turns a raw newline inside streamed css back into valid arguments', () => {
		const inner = '{"path":"/public/styles.css","content":"body {\n color: red"}';
		const outer = JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: inner } }] } }],
		});
		const broken = `data: ${outer.replace('\\n', '\n')}\n`;
		const { out } = rewriteToolCallSse(broken, new Map(), true, patch);
		const line = out.split('\n').find((entry) => entry.startsWith('data: {'));
		expect(line).toBeTruthy();
		const parsed = JSON.parse(line!.slice(5)) as {
			choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }>;
		};
		const args = parsed.choices[0].delta.tool_calls[0].function.arguments;
		expect(JSON.parse(args)).toEqual({
			path: '/public/styles.css',
			content: 'body {\n color: red',
		});
	});

	it('closes a truncated write before the stream finishes', () => {
		expect(jsonCloser('{"path":"/public/styles.css","content":"body {')).toBe('"}');
		const partial = '{"path":"/public/styles.css","content":"body {';
		const payload = {
			choices: [{
				finish_reason: 'length',
				delta: { tool_calls: [{ index: 0, function: { arguments: partial } }] },
			}],
		};
		const { out } = rewriteToolCallSse(`data: ${JSON.stringify(payload)}\n`, new Map(), true, patch);
		const pieces = out
			.split('\n')
			.filter((entry) => entry.startsWith('data: {'))
			.map((entry) => JSON.parse(entry.slice(5)) as {
				choices: Array<{ delta: { tool_calls?: Array<{ function: { arguments: string } }> } }>;
			})
			.flatMap((json) => json.choices[0].delta.tool_calls ?? [])
			.map((call) => call.function.arguments)
			.join('');
		expect(JSON.parse(pieces)).toEqual({
			path: '/public/styles.css',
			content: 'body {',
		});
	});

	it('does not glue the length finish chunk onto the tool closer', () => {
		const finish = {
			p: '8549c590a13d5b',
			id: 'e6d78a67-1d55-4f20-9db1-63f9916ef700',
			object: 'chat.completion.chunk',
			created: 1793849543,
			model: 'deepseek-flash',
			choices: [{ index: 0, delta: { content: '' }, logprobs: null, finish_reason: 'length' }],
			usage: { prompt_tokens: 23038, completion_tokens: 8192, total_tokens: 31230 },
		};
		const state = new Map<number, string>([[0, '{"path":"/public/styles.css","content":"body {']]);
		const { out } = rewriteToolCallSse(`data: ${JSON.stringify(finish)}\n\n`, state, false, patch);
		const payloads = ssePayloads(out);
		expect(payloads.length).toBe(2);
		const parsed = payloads.map((payload) => JSON.parse(payload) as {
			choices: Array<{
				finish_reason?: string;
				delta: { tool_calls?: Array<{ function: { arguments: string } }> };
			}>;
		});
		expect(parsed[0].choices[0].finish_reason).toBe('length');
		expect(parsed[1].choices[0].delta.tool_calls?.[0].function.arguments).toBe('"}');
		expect(JSON.parse(state.get(0) ?? '')).toEqual({
			path: '/public/styles.css',
			content: 'body {',
		});
	});
});

/** Same join rule as eventsource-parser: data lines accumulate until a blank line. */
function ssePayloads(stream: string): string[] {
	const payloads: string[] = [];
	let data = '';
	let count = 0;
	for (const line of stream.split('\n')) {
		if (line === '') {
			if (count > 0) payloads.push(data);
			data = '';
			count = 0;
			continue;
		}
		if (!line.startsWith('data:')) continue;
		const value = line.slice(5).trimStart();
		data = count === 0 ? value : `${data}\n${value}`;
		count++;
	}
	if (count > 0) payloads.push(data);
	return payloads;
}
