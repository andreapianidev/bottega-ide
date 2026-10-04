/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Bottega contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from './terminal.js';

const openMenus = new WeakMap<IContextViewService, { anchor: HTMLElement; close: () => void }>();

/** Compact, live terminal sessions in the existing workbench title toolbar. */
export class BottegaTerminalTabs extends ActionViewItem {

	private readonly sessionListeners = this._register(new DisposableStore());
	private readonly revealFrame = this._register(new MutableDisposable());
	private strip: HTMLElement | undefined;
	private menuButton: HTMLButtonElement | undefined;
	constructor(
		action: IAction,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(undefined, action, { icon: false, label: false });
		this._register(this.terminalGroupService.onDidChangeInstances(() => this.renderSessions(true)));
		this._register(this.terminalGroupService.onDidChangeActiveInstance(() => this.renderSessions(true)));
		this._register(this.terminalService.onAnyInstanceTitleChange(instance => this.updateSessionLabel(instance)));
		this._register(toDisposable(() => {
			const menu = openMenus.get(this.contextViewService);
			if (menu && this.element?.contains(menu.anchor)) {
				menu.close();
			}
		}));
	}

	override get trapsArrowNavigation(): boolean { return true; }

	override render(container: HTMLElement): void {
		// Own the buttons rather than nesting them in ActionViewItem's clickable anchor.
		this.element = container;
		container.classList.add('bottega-terminal-tabs-item');
		this.strip = dom.append(container, dom.$('.bottega-terminal-tabs'));
		this.strip.setAttribute('role', 'tablist');
		this.strip.setAttribute('aria-label', 'Terminali aperti');
		const resizeObserver = new ResizeObserver(() => this.revealActiveSession());
		resizeObserver.observe(this.strip);
		this._register(toDisposable(() => resizeObserver.disconnect()));
		this.menuButton = dom.append(container, dom.$('button.bottega-terminal-menu-button')) as HTMLButtonElement;
		this.menuButton.type = 'button';
		this.menuButton.textContent = '▾';
		this.menuButton.title = 'Apri o cambia terminale';
		this.menuButton.setAttribute('aria-label', 'Apri o cambia terminale');
		this.menuButton.setAttribute('aria-haspopup', 'menu');
		this.menuButton.setAttribute('aria-expanded', 'false');
		this.menuButton.tabIndex = -1;
		this._register(dom.addDisposableListener(this.menuButton, 'click', e => {
			e.stopPropagation();
			this.openMenu(true);
		}));
		let hoverTimer: ReturnType<typeof setTimeout> | undefined;
		const clearHover = () => { if (hoverTimer !== undefined) { clearTimeout(hoverTimer); hoverTimer = undefined; } };
		this._register(dom.addDisposableListener(this.menuButton, 'mouseenter', () => {
			clearHover();
			hoverTimer = setTimeout(() => this.openMenu(false), 250);
		}));
		this._register(dom.addDisposableListener(this.menuButton, 'mouseleave', clearHover));
		this._register(toDisposable(clearHover));
		this._register(dom.addDisposableListener(container, 'keydown', (e: KeyboardEvent) => {
			const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
			const index = buttons.indexOf(container.ownerDocument.activeElement as HTMLButtonElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault(); e.stopPropagation(); this.openMenu(true);
			} else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
				e.preventDefault(); e.stopPropagation();
				const target = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
				buttons[target]?.focus();
				buttons[target]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			} else if (e.key === 'Enter' || e.key === ' ') {
				e.stopPropagation();
			}
		}));
		this.renderSessions(true);
	}

	private openMenu(keyboard: boolean): void {
		if (this.menuButton) {
			void this.commandService.executeCommand('bottega.terminalMenu', this.menuButton, keyboard).catch(error => this.notificationService.error(error));
		}
	}

	private revealActiveSession(): void {
		if (!this.strip) { return; }
		this.revealFrame.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this.strip), () => {
			if (this.strip?.isConnected) {
				this.strip.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		});
	}

	private updateSessionLabel(instance: ITerminalInstance): void {
		const button = this.strip?.querySelector<HTMLButtonElement>(`[data-terminal-id="${instance.instanceId}"]`);
		if (!button) { return; }
		const text = instance.title || 'Terminale';
		if (button.textContent !== text) { button.textContent = text; }
		button.title = instance.description ? `${instance.title} · ${instance.description}` : instance.title;
	}

	private renderSessions(revealActive = false): void {
		if (!this.strip) { return; }
		const focused = this.strip.ownerDocument.activeElement as HTMLElement | null;
		const focusedId = focused?.closest<HTMLElement>('[data-terminal-id]')?.dataset.terminalId;
		const scrollLeft = this.strip.scrollLeft;
		this.sessionListeners.clear();
		dom.clearNode(this.strip);
		for (const instance of this.terminalGroupService.instances) {
			const button = dom.append(this.strip, dom.$('button.bottega-terminal-chip')) as HTMLButtonElement;
			button.type = 'button';
			button.dataset.terminalId = String(instance.instanceId);
			button.textContent = instance.title || 'Terminale';
			button.title = instance.description ? `${instance.title} · ${instance.description}` : instance.title;
			button.setAttribute('role', 'tab');
			const active = instance === this.terminalGroupService.activeInstance;
			button.classList.toggle('active', active);
			button.setAttribute('aria-selected', String(active));
			button.tabIndex = -1;
			this.sessionListeners.add(dom.addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				void this.terminalGroupService.focusInstance(instance).catch(error => this.notificationService.error(error));
			}));
		}
		this.strip.scrollLeft = scrollLeft;
		this.label = this.strip.querySelector<HTMLElement>('.active') ?? this.menuButton;
		if (focusedId) {
			const target = [...this.strip.querySelectorAll<HTMLElement>('[data-terminal-id]')].find(button => button.dataset.terminalId === focusedId);
			(target ?? this.label)?.focus();
		}
		if (revealActive) {
			this.revealActiveSession();
		}
	}

	protected override updateLabel(): void { this.renderSessions(); }
	protected override updateTooltip(): void { /* Each session exposes its complete title. */ }

	override isFocused(): boolean {
		return !!this.element?.contains(this.element.ownerDocument.activeElement);
	}
}

/** Hover opens a context view without focusing it; explicit keyboard/click opens focus its first row. */
CommandsRegistry.registerCommand('bottega.terminalMenu', (accessor, anchor: HTMLElement, keyboard = false) => {
	if (!anchor?.isConnected) { return; }
	const contextViewService = accessor.get(IContextViewService);
	const groupService = accessor.get(ITerminalGroupService);
	const terminalService = accessor.get(ITerminalService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const existing = openMenus.get(contextViewService);
	if (existing?.anchor === anchor) {
		if (keyboard) { contextViewService.getContextViewElement().querySelector<HTMLElement>('[role^="menuitem"]')?.focus(); }
		return;
	}

	const store = new DisposableStore();
	const rowListeners = store.add(new DisposableStore());
	let menu: HTMLElement | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const cancelClose = () => { if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; } };
	const close = () => { if (!closed) { contextViewService.hideContextView(); } };
	const scheduleClose = () => {
		cancelClose();
		closeTimer = setTimeout(() => {
			if (!menu?.contains(anchor.ownerDocument.activeElement)) { close(); }
		}, 280);
	};
	const run = (operation: () => Promise<unknown>) => {
		close();
		void operation().catch(error => notificationService.error(error));
	};
	const renderRows = () => {
		if (!menu) { return; }
		const focusedId = (menu.ownerDocument.activeElement as HTMLElement | null)?.dataset.menuId;
		rowListeners.clear();
		dom.clearNode(menu);
		const addRow = (id: string, text: string, checked: boolean | undefined, operation: () => Promise<unknown>) => {
			const row = dom.append(menu!, dom.$('button.bottega-terminal-menu-row')) as HTMLButtonElement;
			row.type = 'button'; row.tabIndex = -1; row.dataset.menuId = id;
			row.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
			if (checked !== undefined) { row.setAttribute('aria-checked', String(checked)); }
			row.classList.toggle('active', checked === true);
			dom.append(row, dom.$('span.bottega-terminal-menu-check')).textContent = checked ? '✓' : checked === undefined ? '+' : '';
			dom.append(row, dom.$('span.bottega-terminal-menu-text')).textContent = text;
			row.title = text;
			rowListeners.add(dom.addDisposableListener(row, 'click', e => { e.stopPropagation(); run(operation); }));
			if (focusedId === id) { row.focus(); }
		};
		addRow('new', 'Nuovo terminale', undefined, () => commandService.executeCommand('bottega.terminaleQui'));
		addRow('profiles', 'Nuovo con profilo…', undefined, () => commandService.executeCommand('workbench.action.terminal.newWithProfile'));
		if (groupService.instances.length) {
			const separator = dom.append(menu, dom.$('.bottega-terminal-menu-separator'));
			separator.setAttribute('role', 'separator');
			for (const instance of groupService.instances) {
				addRow(String(instance.instanceId), instance.title || 'Terminale', instance === groupService.activeInstance, () => groupService.focusInstance(instance));
			}
		}
		if (focusedId && !menu.contains(menu.ownerDocument.activeElement)) { menu.querySelector<HTMLElement>('button')?.focus(); }
		contextViewService.layout();
	};

	contextViewService.showContextView({
		getAnchor: () => anchor,
		render: container => {
			menu = dom.append(container, dom.$('.bottega-terminal-menu'));
			menu.setAttribute('role', 'menu');
			menu.setAttribute('aria-label', 'Terminali');
			store.add(dom.addDisposableListener(anchor, 'mouseenter', cancelClose));
			store.add(dom.addDisposableListener(anchor, 'mouseleave', scheduleClose));
			store.add(dom.addDisposableListener(menu, 'mouseenter', cancelClose));
			store.add(dom.addDisposableListener(menu, 'mouseleave', scheduleClose));
			store.add(dom.addDisposableListener(menu, 'focusout', () => {
				queueMicrotask(() => { if (!closed && !menu?.contains(anchor.ownerDocument.activeElement)) { scheduleClose(); } });
			}));
			store.add(dom.addDisposableListener(anchor.ownerDocument, 'pointerdown', (e: PointerEvent) => {
				if (!menu?.contains(e.target as Node) && !anchor.contains(e.target as Node)) { close(); }
			}, true));
			store.add(dom.addDisposableListener(anchor.ownerDocument, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Escape') {
					const restoreFocus = !!menu?.contains(anchor.ownerDocument.activeElement);
					e.preventDefault(); e.stopPropagation(); close();
					if (restoreFocus && anchor.isConnected) { anchor.focus(); }
					return;
				}
				if (!menu?.contains(anchor.ownerDocument.activeElement)) { return; }
				const rows = [...menu.querySelectorAll<HTMLButtonElement>('button')];
				const index = rows.indexOf(anchor.ownerDocument.activeElement as HTMLButtonElement);
				if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
					e.preventDefault(); e.stopPropagation();
					const target = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
					rows[target]?.focus(); rows[target]?.scrollIntoView({ block: 'nearest' });
				} else if (e.key === 'Tab') { close(); }
			}, true));
			store.add(groupService.onDidChangeInstances(renderRows));
			store.add(groupService.onDidChangeActiveInstance(renderRows));
			store.add(terminalService.onAnyInstanceTitleChange(instance => {
				const row = menu?.querySelector<HTMLButtonElement>(`[data-menu-id="${instance.instanceId}"]`);
				const label = row?.querySelector<HTMLElement>('.bottega-terminal-menu-text');
				if (!row || !label) { return; }
				const text = instance.title || 'Terminale';
				if (label.textContent !== text) { label.textContent = text; }
				row.title = text;
			}));
			store.add(dom.addDisposableListener(dom.getWindow(anchor), 'blur', close));
			store.add(toDisposable(cancelClose));
			renderRows();
			return store;
		},
		focus: () => { if (keyboard) { menu?.querySelector<HTMLElement>('button')?.focus(); } },
		onHide: () => {
			closed = true;
			anchor.setAttribute('aria-expanded', 'false');
			if (openMenus.get(contextViewService)?.anchor === anchor) { openMenus.delete(contextViewService); }
			store.dispose();
		},
	});
	anchor.setAttribute('aria-expanded', 'true');
	openMenus.set(contextViewService, { anchor, close });
});
