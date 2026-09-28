/**
 * An IntersectionObserver a jsdom test drives by hand: jsdom has no layout,
 * so nothing ever intersects on its own. `intersect(el)` is the element
 * scrolling into view.
 */
export class FakeIntersectionObserver {
	static all: FakeIntersectionObserver[] = [];
	readonly targets = new Set<Element>();
	constructor(
		readonly callback: (
			entries: Array<Partial<IntersectionObserverEntry>>,
		) => void,
		readonly init: IntersectionObserverInit = {},
	) {
		FakeIntersectionObserver.all.push(this);
	}
	observe(target: Element): void {
		this.targets.add(target);
	}
	unobserve(target: Element): void {
		this.targets.delete(target);
	}
	disconnect(): void {
		this.targets.clear();
	}
	takeRecords(): [] {
		return [];
	}
	/** Every observer watching `target` sees it enter the viewport. */
	static intersect(target: Element): void {
		for (const observer of FakeIntersectionObserver.all) {
			if (observer.targets.has(target)) {
				observer.callback([{ isIntersecting: true, target }]);
			}
		}
	}
	static watching(target: Element): boolean {
		return FakeIntersectionObserver.all.some((o) => o.targets.has(target));
	}
}
