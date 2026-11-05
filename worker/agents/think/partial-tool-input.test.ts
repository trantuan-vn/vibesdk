import { describe, expect, it } from 'vitest';
import { createToolInputScan, pushToolInput } from './partial-tool-input';

describe('pushToolInput', () => {
	it('yields a closed path and streams content across chunks', () => {
		const scan = createToolInputScan();
		expect(pushToolInput(scan, '{"path":"src/')).toEqual({ contentDelta: '' });
		expect(scan.path).toBeUndefined();

		const closed = pushToolInput(scan, 'app.js","content":"const x = 1;\\n');
		expect(closed.path).toBe('src/app.js');
		expect(closed.contentDelta).toBe('const x = 1;\n');

		const rest = pushToolInput(scan, 'export {}"}');
		expect(rest.contentDelta).toBe('export {}');
		expect(rest.path).toBeUndefined();
	});

	it('holds an incomplete escape until the next chunk', () => {
		const scan = createToolInputScan();
		pushToolInput(scan, '{"path":"a.ts","content":"hi\\');
		const next = pushToolInput(scan, 'nthere"}');
		expect(next.contentDelta).toBe('\nthere');
	});

	it('does not treat a quoted path inside content as the file path', () => {
		const scan = createToolInputScan();
		const first = pushToolInput(scan, '{"path":"real.ts","content":"see \\"path\\": \\"nope\\""}');
		expect(first.path).toBe('real.ts');
		expect(first.contentDelta).toBe('see "path": "nope"');
		expect(scan.path).toBe('real.ts');
	});
});
