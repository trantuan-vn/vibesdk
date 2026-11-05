/**
 * DeepSeek streams `write` arguments as one JSON string. Two things make that
 * string die before the tool runs, which the chat shows as
 * "Failed to write <path>":
 *
 * - A raw newline inside the SSE `data:` JSON (CSS/JS) splits the event, so
 *   everything after the first line of the file is dropped.
 * - The model stops before the argument object is closed (token limit). The
 *   OpenAI parser only emits a tool call once the arguments are valid JSON,
 *   so the write never executes.
 *
 * Reassemble those frames, escape raw controls inside the argument text, and
 * append the missing closers so the tool still runs.
 */

export type ToolArgumentState = Map<number, string>;

export function ensureToolCallFunction(call: unknown): void {
	if (!call || typeof call !== 'object') return;
	const record = call as { function?: unknown };
	if (!record.function || typeof record.function !== 'object') {
		record.function = { arguments: '' };
		return;
	}
	const fn = record.function as { arguments?: unknown };
	const raw = typeof fn.arguments === 'string'
		? fn.arguments
		: fn.arguments == null ? '' : String(fn.arguments);
	fn.arguments = escapeRawControls(raw);
}

/** Suffix that closes a truncated JSON value, or '' when it is already valid. */
export function jsonCloser(input: string): string {
	if (isJson(input)) return '';
	let inString = false;
	let escape = false;
	const stack: string[] = [];
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\') {
				escape = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') stack.push('}');
		else if (ch === '[') stack.push(']');
		else if ((ch === '}' || ch === ']') && stack.length > 0) stack.pop();
	}

	let suffix = '';
	if (escape) suffix += '\\';
	if (inString) suffix += '"';
	const trimmed = input.trimEnd();
	if (trimmed.endsWith(',') || trimmed.endsWith(':')) suffix = `null${suffix}`;
	while (stack.length > 0) suffix += stack.pop();
	return suffix && isJson(input + suffix) ? suffix : '';
}

/**
 * Pull complete SSE records out of `buffer`. A newline inside a JSON string
 * is escaped and does not end the record. Incomplete trailing input is `rest`.
 */
export function pullSseEvents(buffer: string): { events: string[]; rest: string } {
	const events: string[] = [];
	let i = 0;
	while (i < buffer.length) {
		const lineBreak = buffer.indexOf('\n', i);
		const lineEnd = lineBreak === -1 ? buffer.length : lineBreak;
		const line = buffer.slice(i, lineEnd).replace(/\r$/, '');
		const trimmed = line.trimStart();
		if (!trimmed.startsWith('data:')) {
			if (lineBreak === -1) return { events, rest: buffer.slice(i) };
			events.push(line);
			i = lineBreak + 1;
			continue;
		}
		const indent = line.length - trimmed.length;
		const tag = trimmed.startsWith('data: ') ? 'data: '.length : 'data:'.length;
		const payloadStart = i + indent + tag;
		if (buffer.startsWith('[DONE]', payloadStart)) {
			const doneEnd = payloadStart + '[DONE]'.length;
			if (doneEnd >= buffer.length) return { events, rest: buffer.slice(i) };
			events.push('data: [DONE]');
			i = doneEnd;
			if (buffer[i] === '\r') i++;
			if (buffer[i] === '\n') i++;
			continue;
		}
		const scanned = scanJsonValue(buffer, payloadStart);
		if (!scanned) return { events, rest: buffer.slice(i) };
		events.push(`data: ${scanned.repaired}`);
		i = scanned.end;
		if (buffer[i] === '\r') i++;
		if (buffer[i] === '\n') i++;
	}
	return { events, rest: '' };
}

export function rewriteToolCallSse(
	buffer: string,
	state: ToolArgumentState,
	finalize: boolean,
	patch: (json: Record<string, unknown>) => void,
): { out: string; rest: string } {
	const pulled = pullSseEvents(finalize && buffer.trim() ? `${buffer}\n` : buffer);
	const lines: string[] = [];
	for (const event of pulled.events) {
		if (event.trim() === 'data: [DONE]') {
			for (const closer of closerLines(state)) appendSseEvent(lines, closer);
			appendSseEvent(lines, 'data: [DONE]');
			continue;
		}
		const rewritten = rewriteDataEvent(event, state, patch);
		appendSseEvent(lines, rewritten.text);
		if (rewritten.finished) {
			for (const closer of closerLines(state)) appendSseEvent(lines, closer);
		}
	}
	if (finalize) {
		for (const closer of closerLines(state)) appendSseEvent(lines, closer);
	}
	if (lines.length === 0) return { out: '', rest: finalize ? '' : pulled.rest };
	if (lines[lines.length - 1] !== '') lines.push('');
	return { out: `${lines.join('\n')}\n`, rest: finalize ? '' : pulled.rest };
}

/** One SSE event per call. A blank line ends the previous event so data lines are not joined. */
function appendSseEvent(lines: string[], event: string): void {
	if (event.trim() === '') {
		if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
		return;
	}
	if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
	lines.push(event.trimStart().startsWith('data:') ? event.trim() : event);
}

function rewriteDataEvent(
	event: string,
	state: ToolArgumentState,
	patch: (json: Record<string, unknown>) => void,
): { text: string; finished: boolean } {
	const trimmed = event.trimStart();
	if (!trimmed.startsWith('data:')) return { text: event, finished: false };
	const payload = trimmed.slice(5).trim();
	if (!payload || payload === '[DONE]') return { text: event, finished: false };
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(payload) as Record<string, unknown>;
	} catch {
		return { text: event, finished: false };
	}
	patch(json);
	noteArguments(json, state);
	return { text: `data: ${JSON.stringify(json)}`, finished: hasFinishReason(json) };
}

function noteArguments(json: Record<string, unknown>, state: ToolArgumentState): void {
	const choices = json.choices;
	if (!Array.isArray(choices)) return;
	for (const choice of choices) {
		const toolCalls = (choice as { delta?: { tool_calls?: unknown } }).delta?.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		for (const call of toolCalls) {
			if (!call || typeof call !== 'object') continue;
			const record = call as { index?: unknown; function?: { arguments?: unknown } };
			const index = typeof record.index === 'number' ? record.index : 0;
			const args = record.function?.arguments;
			if (typeof args !== 'string' || args.length === 0) continue;
			state.set(index, (state.get(index) ?? '') + args);
		}
	}
}

function hasFinishReason(json: Record<string, unknown>): boolean {
	const choices = json.choices;
	if (!Array.isArray(choices)) return false;
	return choices.some((choice) => (choice as { finish_reason?: unknown }).finish_reason != null);
}

function closerLines(state: ToolArgumentState): string[] {
	const lines: string[] = [];
	for (const [index, args] of state) {
		const suffix = jsonCloser(args);
		if (!suffix) continue;
		state.set(index, args + suffix);
		lines.push(`data: ${JSON.stringify({
			choices: [{
				index: 0,
				delta: { tool_calls: [{ index, function: { arguments: suffix } }] },
			}],
		})}`);
	}
	return lines;
}

function escapeRawControls(value: string): string {
	return value.replace(/[\u0000-\u001F]/g, (ch) => {
		if (ch === '\n') return '\\n';
		if (ch === '\r') return '\\r';
		if (ch === '\t') return '\\t';
		return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
	});
}

function isJson(input: string): boolean {
	try {
		JSON.parse(input);
		return true;
	} catch {
		return false;
	}
}

/** Scan one JSON value. Raw newlines inside strings become `\\n`. */
function scanJsonValue(buffer: string, start: number): { repaired: string; end: number } | null {
	let j = start;
	while (j < buffer.length && (buffer[j] === ' ' || buffer[j] === '\t')) j++;
	if (j >= buffer.length) return null;
	if (buffer[j] !== '{' && buffer[j] !== '[') {
		const nl = buffer.indexOf('\n', j);
		if (nl === -1) return null;
		return { repaired: buffer.slice(j, nl).replace(/\r$/, ''), end: nl };
	}

	let repaired = '';
	let depth = 0;
	let inString = false;
	let escape = false;
	for (; j < buffer.length; j++) {
		const ch = buffer[j];
		if (inString) {
			if (escape) {
				repaired += ch;
				escape = false;
				continue;
			}
			if (ch === '\\') {
				if (j + 1 >= buffer.length) return null;
				repaired += ch;
				escape = true;
				continue;
			}
			if (ch === '\n') {
				repaired += '\\n';
				continue;
			}
			if (ch === '\r') {
				repaired += '\\r';
				continue;
			}
			repaired += ch;
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			repaired += ch;
			continue;
		}
		if (ch === '{' || ch === '[') {
			depth++;
			repaired += ch;
			continue;
		}
		if (ch === '}' || ch === ']') {
			depth--;
			repaired += ch;
			if (depth === 0) return { repaired, end: j + 1 };
			continue;
		}
		repaired += ch;
	}
	return null;
}
