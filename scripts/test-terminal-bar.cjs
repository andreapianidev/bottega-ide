/* Terminal toolbar interaction regression tests. Run: node --test scripts/test-terminal-bar.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('../extensions/bottega-home/node_modules/esbuild');
const { JSDOM } = require('../extensions/bottega-home/node_modules/jsdom');

const source = transformSync(fs.readFileSync(path.join(__dirname, '../brand/terminal-bar.ts'), 'utf8'), {
	loader: 'ts', format: 'cjs', target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
}).code;

class DisposableStore {
	constructor() { this.items = []; }
	add(item) { this.items.push(item); return item; }
	clear() { for (const item of this.items.splice(0)) { item.dispose(); } }
	dispose() { this.clear(); }
}
class MutableDisposable {
	set value(value) { this.current?.dispose(); this.current = value; }
	get value() { return this.current; }
	dispose() { this.value = undefined; }
}
function emitter() {
	const listeners = new Set();
	return { event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, fire: value => { for (const listener of [...listeners]) { listener(value); } } };
}

function fixture({ detached = false } = {}) {
	const documentWindow = new JSDOM('<!doctype html><body><input id="terminal-input"><button id="anchor">Terminale</button><div id="toolbar"></div></body>', { pretendToBeVisual: true }).window;
	const scrolls = [], frames = new Set(), resizeObservers = new Set();
	documentWindow.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this); };
	class ResizeObserver {
		constructor(callback) { this.callback = callback; }
		observe() { resizeObservers.add(this); }
		disconnect() { resizeObservers.delete(this); }
	}
	const { document } = documentWindow;
	const tokens = Object.fromEntries(['ICommandService', 'IContextViewService', 'INotificationService', 'ITerminalGroupService', 'ITerminalService'].map(name => [name, Object.assign(() => {}, { id: name })]));
	const commands = new Map();
	const changes = emitter(), activeChanges = emitter(), titles = emitter();
	const errors = [], calls = [];
	const first = { instanceId: 1, title: 'Primo terminale', description: 'Bottega' };
	const second = { instanceId: 2, title: 'Secondo terminale', description: '' };
	const group = {
		instances: [first, second], activeInstance: first,
		onDidChangeInstances: changes.event, onDidChangeActiveInstance: activeChanges.event,
		async focusInstance(instance) { this.activeInstance = instance; activeChanges.fire(); document.getElementById('terminal-input').focus(); }
	};
	let current;
	const context = {
		showContextView(delegate) {
			this.hideContextView();
			const container = document.body.appendChild(document.createElement('div'));
			const disposable = delegate.render(container);
			current = { delegate, container, disposable };
			delegate.focus?.();
			return { close: () => this.hideContextView() };
		},
		hideContextView() {
			if (!current) { return; }
			const previous = current; current = undefined;
			previous.delegate.onHide?.(); previous.disposable.dispose(); previous.container.remove();
		},
		getContextViewElement: () => current?.container,
		layout() {}
	};
	const serviceMap = {
		IContextViewService: context, ITerminalGroupService: group,
		ITerminalService: { onAnyInstanceTitleChange: titles.event },
		INotificationService: { error: error => errors.push(error) },
	};
	const accessor = { get: token => serviceMap[token.id] };
	serviceMap.ICommandService = {
		executeCommand(id, ...args) {
			calls.push(id);
			try { return Promise.resolve(commands.get(id)?.(accessor, ...args)); }
			catch (error) { return Promise.reject(error); }
		}
	};
	class ActionViewItem {
		constructor(_context, action) { this.action = action; this.store = new DisposableStore(); }
		_register(item) { return this.store.add(item); }
		dispose() { this.store.dispose(); }
	}
	const dependencies = {
		'../../../../base/browser/dom.js': {
			$(selector) { const [tag, ...classes] = selector.split('.'); const element = document.createElement(tag || 'div'); element.className = classes.join(' '); return element; },
			append: (parent, child) => parent.appendChild(child), clearNode: node => node.replaceChildren(), getWindow: () => documentWindow,
			scheduleAtNextAnimationFrame(_window, callback) { frames.add(callback); return { dispose: () => frames.delete(callback) }; },
			addDisposableListener(target, event, listener, options) { target.addEventListener(event, listener, options); return { dispose: () => target.removeEventListener(event, listener, options) }; }
		},
		'../../../../base/browser/ui/actionbar/actionViewItems.js': { ActionViewItem },
		'../../../../base/common/lifecycle.js': { DisposableStore, MutableDisposable, toDisposable: dispose => ({ dispose }) },
		'../../../../platform/commands/common/commands.js': { ICommandService: tokens.ICommandService, CommandsRegistry: { registerCommand: (id, handler) => commands.set(id, handler) } },
		'../../../../platform/contextview/browser/contextView.js': { IContextViewService: tokens.IContextViewService },
		'../../../../platform/notification/common/notification.js': { INotificationService: tokens.INotificationService },
		'./terminal.js': { ITerminalGroupService: tokens.ITerminalGroupService, ITerminalService: tokens.ITerminalService }
	};
	const module = { exports: {} };
	vm.runInNewContext(source, { module, exports: module.exports, require: id => { assert.ok(dependencies[id], `Unexpected dependency: ${id}`); return dependencies[id]; }, setTimeout, clearTimeout, queueMicrotask, ResizeObserver }, { filename: 'bottegaTerminalBar.js' });
	const toolbar = new module.exports.BottegaTerminalTabs({ id: 'terminal.focus' }, group, serviceMap.ITerminalService, serviceMap.ICommandService, context, serviceMap.INotificationService);
	const toolbarContainer = document.getElementById('toolbar');
	if (detached) { toolbarContainer.remove(); }
	toolbar.render(toolbarContainer);
	return {
		document, window: documentWindow, group, first, second, changes, titles, calls, errors, toolbar, toolbarContainer, scrolls,
		flushFrames() { for (const callback of [...frames]) { frames.delete(callback); callback(); } },
		resize() { for (const observer of [...resizeObservers]) { observer.callback(); } },
		open: keyboard => serviceMap.ICommandService.executeCommand('bottega.terminalMenu', document.getElementById('anchor'), keyboard),
		close() { toolbar.dispose(); context.hideContextView(); documentWindow.close(); }
	};
}

test('hover menu preserves terminal input focus and creates nothing', async () => {
	const f = fixture();
	try {
		const input = f.document.getElementById('terminal-input'); input.focus();
		await f.open(false);
		assert.equal(f.document.activeElement, input);
		assert.equal(f.document.querySelectorAll('.bottega-terminal-menu-row').length, 4);
		assert.equal(f.calls.includes('bottega.terminaleQui'), false);
		f.document.getElementById('anchor').dispatchEvent(new f.window.MouseEvent('mouseleave'));
		await new Promise(resolve => setTimeout(resolve, 320));
		assert.equal(f.document.querySelector('.bottega-terminal-menu'), null);
		assert.equal(f.document.activeElement, input);
	} finally { f.close(); }
});

test('new terminal action invokes the existing create command only on click', async () => {
	const f = fixture();
	try {
		await f.open(false);
		f.document.querySelector('[data-menu-id="new"]').click();
		assert.equal(f.calls.filter(id => id === 'bottega.terminaleQui').length, 1);
		assert.equal(f.document.querySelector('.bottega-terminal-menu'), null);
		assert.deepEqual(f.errors, []);
	} finally { f.close(); }
});

test('menu selects an existing session and toolbar reacts to rename and removal', async () => {
	const f = fixture();
	try {
		await f.open(false);
		f.document.querySelector('[data-menu-id="2"]').click();
		assert.equal(f.group.activeInstance, f.second);
		assert.equal(f.document.querySelector('.bottega-terminal-chip.active').dataset.terminalId, '2');
		f.second.title = 'Nome aggiornato'; f.titles.fire(f.second);
		assert.equal(f.document.querySelector('.bottega-terminal-chip.active').textContent, 'Nome aggiornato');
		await f.open(false);
		f.group.instances = [f.second]; f.changes.fire();
		assert.equal(f.document.querySelectorAll('.bottega-terminal-chip').length, 1);
		assert.equal(f.document.querySelector('[data-menu-id="1"]'), null);
		assert.equal(f.document.querySelector('[data-menu-id="2"]').getAttribute('aria-checked'), 'true');
	} finally { f.close(); }
});

test('keyboard menu supports arrows and Escape returns focus to its trigger', async () => {
	const f = fixture();
	try {
		await f.open(true);
		assert.equal(f.document.activeElement.dataset.menuId, 'new');
		f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(f.document.activeElement.dataset.menuId, 'profiles');
		f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(f.document.querySelector('.bottega-terminal-menu'), null);
		assert.equal(f.document.activeElement.id, 'anchor');
		assert.equal(f.document.getElementById('anchor').getAttribute('aria-expanded'), 'false');
	} finally { f.close(); }
});

test('frequent title updates preserve toolbar and menu nodes, focus, scrolling and click handlers', async () => {
	const f = fixture();
	try {
		const chip = f.document.querySelector('[data-terminal-id="2"]');
		const otherChip = f.document.querySelector('[data-terminal-id="1"]');
		const strip = f.document.querySelector('.bottega-terminal-tabs');
		chip.focus();
		strip.scrollLeft = 83;
		const title = '<img src=x onerror=alert(1)> & Codex';
		f.second.title = title; f.titles.fire(f.second);
		assert.equal(f.document.querySelector('[data-terminal-id="2"]'), chip);
		assert.equal(f.document.querySelector('[data-terminal-id="1"]'), otherChip);
		assert.equal(f.document.activeElement, chip);
		assert.equal(strip.scrollLeft, 83);
		assert.equal(chip.textContent, title);
		assert.equal(chip.title, title);
		assert.equal(chip.querySelector('img'), null);
		await f.open(false);
		const row = f.document.querySelector('[data-menu-id="2"]');
		const label = row.querySelector('.bottega-terminal-menu-text');
		const otherRow = f.document.querySelector('[data-menu-id="1"]');
		const menu = f.document.querySelector('.bottega-terminal-menu');
		row.focus(); menu.scrollTop = 42;
		row.dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true }));
		for (let frame = 0; frame < 5; frame++) {
			f.second.title = `${title} ${frame}`; f.titles.fire(f.second);
		}
		assert.equal(f.document.querySelector('[data-menu-id="2"]'), row);
		assert.equal(row.querySelector('.bottega-terminal-menu-text'), label);
		assert.equal(f.document.querySelector('[data-menu-id="1"]'), otherRow);
		assert.equal(f.document.querySelector('[data-terminal-id="2"]'), chip);
		assert.equal(f.document.activeElement, row);
		assert.equal(menu.scrollTop, 42);
		assert.equal(strip.scrollLeft, 83);
		assert.equal(label.textContent, `${title} 4`);
		assert.equal(row.title, `${title} 4`);
		assert.equal(menu.querySelector('img'), null);
		row.dispatchEvent(new f.window.MouseEvent('mouseup', { bubbles: true }));
		row.click();
		assert.equal(f.group.activeInstance, f.second);
		assert.equal(f.document.querySelector('.bottega-terminal-menu'), null);
		assert.deepEqual(f.errors, []);
	} finally { f.close(); }
});

test('active session is revealed after DOM insertion and resize, but not on title updates', async () => {
	const f = fixture({ detached: true });
	try {
		assert.equal(f.scrolls.length, 0);
		f.document.body.appendChild(f.toolbarContainer);
		f.flushFrames();
		assert.equal(f.scrolls.at(-1).dataset.terminalId, '1');
		await f.group.focusInstance(f.second);
		assert.equal(f.scrolls.at(-1).dataset.terminalId, '1');
		f.flushFrames();
		assert.equal(f.scrolls.at(-1).dataset.terminalId, '2');
		const count = f.scrolls.length;
		f.second.title = 'Codex aggiornato'; f.titles.fire(f.second); f.flushFrames();
		assert.equal(f.scrolls.length, count);
		f.resize(); f.flushFrames();
		assert.equal(f.scrolls.length, count + 1);
		assert.equal(f.scrolls.at(-1).dataset.terminalId, '2');
		f.resize(); f.toolbar.dispose(); f.flushFrames();
		assert.equal(f.scrolls.length, count + 1);
	} finally { f.close(); }
});
