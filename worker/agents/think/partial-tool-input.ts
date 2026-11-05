/**
 * Incremental scan of a streamed tool-argument JSON object.
 * DeepSeek emits `write` arguments token-by-token; the chat UI only hears
 * `tool-input-start` until the whole JSON parses, so a long file looks stuck
 * on "Writing…". This walks the buffer once and yields the closed `path`
 * plus each newly decoded `content` character.
 */
export type ToolInputScan = {
	buf: string;
	i: number;
	state: 'top' | 'in-string' | 'after-key' | 'after-colon';
	stringKind: 'key' | 'path' | 'content' | 'other';
	token: string;
	escape: boolean;
	unicode: string | null;
	path?: string;
};

const PATH_KEYS = new Set(['path', 'filePath', 'file']);
const CONTENT_KEYS = new Set(['content', 'contents']);

export function createToolInputScan(): ToolInputScan {
	return {
		buf: '',
		i: 0,
		state: 'top',
		stringKind: 'key',
		token: '',
		escape: false,
		unicode: null,
	};
}

export function pushToolInput(
	scan: ToolInputScan,
	delta: string,
): { path?: string; contentDelta: string } {
	if (delta) scan.buf += delta;
	let contentDelta = '';
	let pathJustClosed: string | undefined;

	const emit = (text: string): void => {
		if (scan.stringKind === 'key' || scan.stringKind === 'path') scan.token += text;
		else if (scan.stringKind === 'content') contentDelta += text;
	};

	while (scan.i < scan.buf.length) {
		const ch = scan.buf[scan.i];

		if (scan.state === 'top') {
			if (ch === '"') {
				scan.state = 'in-string';
				scan.stringKind = 'key';
				scan.token = '';
				scan.escape = false;
				scan.unicode = null;
			}
			scan.i++;
			continue;
		}

		if (scan.state === 'after-key') {
			if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
				scan.i++;
				continue;
			}
			if (ch === ':') {
				scan.state = 'after-colon';
				scan.i++;
				continue;
			}
			scan.state = 'top';
			continue;
		}

		if (scan.state === 'after-colon') {
			if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
				scan.i++;
				continue;
			}
			if (ch === '"') {
				scan.stringKind = PATH_KEYS.has(scan.token)
					? 'path'
					: CONTENT_KEYS.has(scan.token)
						? 'content'
						: 'other';
				scan.token = '';
				scan.state = 'in-string';
				scan.escape = false;
				scan.unicode = null;
				scan.i++;
				continue;
			}
			scan.state = 'top';
			continue;
		}

		if (scan.unicode !== null) {
			scan.unicode += ch;
			scan.i++;
			if (scan.unicode.length < 4) continue;
			const hex = scan.unicode;
			scan.unicode = null;
			if (/^[0-9a-fA-F]{4}$/.test(hex)) {
				emit(String.fromCharCode(Number.parseInt(hex, 16)));
			}
			continue;
		}

		if (scan.escape) {
			scan.escape = false;
			scan.i++;
			if (ch === 'u') {
				scan.unicode = '';
				continue;
			}
			const simple: Record<string, string> = {
				'"': '"',
				'\\': '\\',
				'/': '/',
				b: '\b',
				f: '\f',
				n: '\n',
				r: '\r',
				t: '\t',
			};
			emit(simple[ch] ?? ch);
			continue;
		}

		if (ch === '\\') {
			scan.escape = true;
			scan.i++;
			continue;
		}

		if (ch === '"') {
			if (scan.stringKind === 'key') {
				scan.state = 'after-key';
			} else {
				if (scan.stringKind === 'path' && scan.path === undefined && scan.token.length > 0) {
					scan.path = scan.token;
					pathJustClosed = scan.token;
				}
				scan.token = '';
				scan.state = 'top';
			}
			scan.i++;
			continue;
		}

		scan.i++;
		emit(ch);
	}

	if (scan.i > 8192) {
		scan.buf = scan.buf.slice(scan.i);
		scan.i = 0;
	}

	return pathJustClosed ? { path: pathJustClosed, contentDelta } : { contentDelta };
}
