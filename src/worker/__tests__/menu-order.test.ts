import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
	compareMenuItems,
	getMenuItemStableKey,
	normalizeMenuOrder
} from '../../../js/menu-order.js';

describe('ordinamento canonico del menu', () => {
	const fixturePath = (relativePath: string) =>
		fileURLToPath(new URL(relativePath, import.meta.url).href);

	it('produce lo stesso ordine per ogni permutazione con order uguale', () => {
		const records = [
			{ _filename: 'gamma.md', order: 0 },
			{ _filename: 'alpha.md', order: 0 },
			{ _filename: 'beta.md', order: 0 }
		];
		const permutations = [
			records,
			[records[0], records[2], records[1]],
			[records[1], records[0], records[2]],
			[records[1], records[2], records[0]],
			[records[2], records[0], records[1]],
			[records[2], records[1], records[0]]
		];

		for (const permutation of permutations) {
			expect([...permutation].sort(compareMenuItems).map(item => item._filename))
				.toEqual(['alpha.md', 'beta.md', 'gamma.md']);
		}
	});

	it('fa prevalere order e tratta numeri/stringhe nello stesso modo', () => {
		const records = [
			{ _filename: 'zero-b.md', order: '0' },
			{ _filename: 'second.md', order: 2 },
			{ _filename: 'zero-a.md' },
			{ _filename: 'first.md', order: '1' }
		];

		expect(records.sort(compareMenuItems).map(item => item._filename)).toEqual([
			'zero-a.md',
			'zero-b.md',
			'first.md',
			'second.md'
		]);
	});

	it('usa filename come identita equivalente a _filename nei dati browser', () => {
		expect(getMenuItemStableKey({ _filename: 'item.md' })).toBe('item.md');
		expect(getMenuItemStableKey({ filename: 'item.md' })).toBe('item.md');
		expect(compareMenuItems(
			{ filename: 'zeta.md', order: 0 },
			{ _filename: 'alfa.md', order: 0 }
		)).toBeGreaterThan(0);
	});

	it('normalizza order mancanti o non numerici senza introdurre NaN', () => {
		expect(normalizeMenuOrder(undefined)).toBe(0);
		expect(normalizeMenuOrder('')).toBe(0);
		expect(normalizeMenuOrder('non-numerico')).toBe(0);
		expect(normalizeMenuOrder('-2')).toBe(-2);
	});

	it('espone lo stesso comparatore nel runtime browser', () => {
		const source = fs.readFileSync(fixturePath('../../../js/menu-order.js'), 'utf8');
		const context = vm.createContext({});
		vm.runInContext(source, context);

		const browserApi = (context as any).MenuOrder;
		expect(typeof browserApi?.compareMenuItems).toBe('function');
		expect([
			{ filename: 'zeta.md', order: 0 },
			{ filename: 'alfa.md', order: 0 }
		].sort(browserApi.compareMenuItems).map(item => item.filename))
			.toEqual(['alfa.md', 'zeta.md']);
	});

	it('carica il comparatore prima dei consumer pubblico e admin', () => {
		const menuHtml = fs.readFileSync(fixturePath('../../../menu.html'), 'utf8');
		const adminHtml = fs.readFileSync(fixturePath('../../../admin/index.html'), 'utf8');
		const menuOrderScript = '<script src="js/menu-order.js';
		const menuConsumerScript = '<script src="js/app.js';
		const adminOrderScript = '<script src="../js/menu-order.js';
		const adminConsumerScript = '<script src="cms-simple.js';

		expect(menuHtml.indexOf(menuOrderScript)).toBeGreaterThan(-1);
		expect(menuHtml.indexOf(menuOrderScript)).toBeLessThan(menuHtml.indexOf(menuConsumerScript));
		expect(adminHtml.indexOf(adminOrderScript)).toBeGreaterThan(-1);
		expect(adminHtml.indexOf(adminOrderScript)).toBeLessThan(adminHtml.indexOf(adminConsumerScript));
	});
});
