import { Base } from './base';
import { Position, WORLD_PIXEL_SIZE, WORLD_TILE_SIZE } from './world-position';

import type { WPlaceBot } from './bot';

/**
 * Wplace splits the world into "regions" (the `🇩🇪 Halle (Saale) #9` label you
 * see when clicking a pixel). Probing `/s0/pixel/` shows the split is a plain
 * grid: every region is exactly 4000x4000 world pixels (4x4 tiles) and
 * `region.id === regionY * 512 + regionX`. So borders need no network calls at
 * all — only the names do.
 */
export const REGION_SIZE = 4000;

/** Regions per world axis (512). Region id is `y * REGIONS_PER_AXIS + x` */
export const REGIONS_PER_AXIS = WORLD_PIXEL_SIZE / REGION_SIZE;

export type Region = {
	/** Region column, 0..511 */
	x: number;
	/** Region row, 0..511 */
	y: number;
	/** Region id as reported by the backend */
	id: number;
	/** X inside the region, 0..3999 */
	localX: number;
	/** Y inside the region, 0..3999 */
	localY: number;
};

/** Region that owns a global pixel, plus that pixel's coordinates inside it */
export function regionAt(globalX: number, globalY: number): Region {
	const x = Math.floor(globalX / REGION_SIZE);
	const y = Math.floor(globalY / REGION_SIZE);
	return {
		x,
		y,
		id: y * REGIONS_PER_AXIS + x,
		localX: globalX - x * REGION_SIZE,
		localY: globalY - y * REGION_SIZE,
	};
}

const NAMES_KEY = 'wbot-region-names';

/** Stop drawing the grid once regions get smaller than this on screen */
const MIN_CELL_PX = 24;

/** Only ask the backend for a region name once it is at least this big on screen */
const MIN_NAME_PX = 200;

/** Keep the name cache from growing forever */
const MAX_CACHED_NAMES = 4096;

/** Draws wplace region borders on top of the map */
export class RegionGrid extends Base {
	public readonly canvas = document.createElement('canvas');

	protected readonly context = this.canvas.getContext('2d')!;

	/** Region id -> `Halle (Saale) #2`. Persisted, since regions never move */
	protected names = new Map<number, string>();

	/** Region ids we already asked for, so a miss isn't retried every frame */
	protected requested = new Set<number>();

	protected nameQueue: Region[] = [];

	protected fetchingName = false;

	protected frame = 0;

	/** Last known cursor position, used for the hovered region readout */
	protected pointer?: Position;

	public constructor(protected bot: WPlaceBot) {
		super();
		this.canvas.className = 'wregions';
		document.body.append(this.canvas);
		this.loadNames();

		this.registerEvent(window, 'resize', () => {
			this.update();
		});
		this.registerEvent(window, 'mousemove', (event: MouseEvent) => {
			// The bot fakes mousemove for every pixel it paints — don't redraw for those
			if (!event.isTrusted) return;
			this.pointer = { x: event.clientX, y: event.clientY };
			this.update();
		});

		this.update();
	}

	/** Region under the given screen position */
	public regionAtScreen(position: Position): Region | undefined {
		if (this.bot.$stars.length === 0) return;
		const { anchorScreenPosition, anchorWorldPosition, pixelSize } = this.bot.findAnchorsForScreen(position);
		if (!Number.isFinite(pixelSize) || pixelSize <= 0) return;
		return regionAt(
			anchorWorldPosition.x + (position.x - anchorScreenPosition.x) / pixelSize,
			anchorWorldPosition.y + (position.y - anchorScreenPosition.y) / pixelSize
		);
	}

	/** Schedule a redraw. Cheap to call from every map mutation */
	public update() {
		this.frame ||= requestAnimationFrame(this.render.bind(this));
	}

	public destroy() {
		super.destroy();
		cancelAnimationFrame(this.frame);
		this.canvas.remove();
	}

	protected render() {
		this.frame = 0;
		const { canvas, context } = this;
		const width = window.innerWidth;
		const height = window.innerHeight;
		const ratio = window.devicePixelRatio || 1;

		const pixelWidth = Math.round(width * ratio);
		const pixelHeight = Math.round(height * ratio);
		if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
			canvas.style.width = `${width}px`;
			canvas.style.height = `${height}px`;
		}
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		if (!this.bot.showRegions || this.bot.$stars.length === 0) return;

		const { anchorScreenPosition, anchorWorldPosition, pixelSize } = this.bot.findAnchorsForScreen({
			x: width / 2,
			y: height / 2,
		});
		if (!Number.isFinite(pixelSize) || pixelSize <= 0) return;

		const cell = REGION_SIZE * pixelSize;
		if (cell < MIN_CELL_PX) return;

		const screenX = (worldX: number) => (worldX - anchorWorldPosition.x) * pixelSize + anchorScreenPosition.x;
		const screenY = (worldY: number) => (worldY - anchorWorldPosition.y) * pixelSize + anchorScreenPosition.y;
		const firstX = Math.floor((anchorWorldPosition.x - anchorScreenPosition.x / pixelSize) / REGION_SIZE);
		const firstY = Math.floor((anchorWorldPosition.y - anchorScreenPosition.y / pixelSize) / REGION_SIZE);
		// +1 because the first line starts up to a full cell off the left/top edge
		const lastX = firstX + Math.ceil(width / cell) + 1;
		const lastY = firstY + Math.ceil(height / cell) + 1;

		const hovered = this.pointer && this.regionAtScreen(this.pointer);

		// Faint fill of the region under the cursor, so the current one pops out
		if (hovered) {
			context.fillStyle = 'rgb(102 187 180 / 12%)';
			context.fillRect(screenX(hovered.x * REGION_SIZE), screenY(hovered.y * REGION_SIZE), cell, cell);
		}

		// Dark halo underneath so the lines stay readable on any artwork
		context.beginPath();
		for (let x = firstX; x <= lastX; x++) {
			const sx = Math.round(screenX(x * REGION_SIZE)) + 0.5;
			context.moveTo(sx, 0);
			context.lineTo(sx, height);
		}
		for (let y = firstY; y <= lastY; y++) {
			const sy = Math.round(screenY(y * REGION_SIZE)) + 0.5;
			context.moveTo(0, sy);
			context.lineTo(width, sy);
		}
		context.lineWidth = 3;
		context.strokeStyle = 'rgb(0 0 0 / 45%)';
		context.stroke();
		context.lineWidth = 1;
		context.strokeStyle = '#66bbb4';
		context.stroke();

		this.renderLabels(context, { firstX, firstY, lastX, lastY, cell, screenX, screenY, width, height });
		if (hovered) this.renderHovered(context, hovered);
	}

	/** Region name (or id) in the top-left corner of every visible region */
	protected renderLabels(
		context: CanvasRenderingContext2D,
		view: {
			firstX: number;
			firstY: number;
			lastX: number;
			lastY: number;
			cell: number;
			screenX: (worldX: number) => number;
			screenY: (worldY: number) => number;
			width: number;
			height: number;
		}
	) {
		context.font = '16px Tiny5, monospace';
		context.textBaseline = 'top';

		for (let y = view.firstY; y <= view.lastY; y++)
			for (let x = view.firstX; x <= view.lastX; x++) {
				if (x < 0 || y < 0 || x >= REGIONS_PER_AXIS || y >= REGIONS_PER_AXIS) continue;
				const id = y * REGIONS_PER_AXIS + x;
				const left = view.screenX(x * REGION_SIZE);
				const top = view.screenY(y * REGION_SIZE);

				if (view.cell >= MIN_NAME_PX) this.requestName({ x, y, id, localX: 0, localY: 0 });

				const text = this.names.get(id) ?? `#${id}`;
				const metrics = context.measureText(text);
				if (metrics.width + 12 > view.cell) continue;

				// Pin the label inside the viewport so half-visible regions stay named
				const textX = Math.min(Math.max(left + 6, 6), left + view.cell - metrics.width - 6);
				const textY = Math.min(Math.max(top + 6, 6), top + view.cell - 22);
				if (textX > view.width || textY > view.height || textX + metrics.width < 0 || textY < -20) continue;

				context.lineWidth = 3;
				context.strokeStyle = 'rgb(0 0 0 / 70%)';
				context.strokeText(text, textX, textY);
				context.fillStyle = '#fff';
				context.fillText(text, textX, textY);
			}
	}

	/** Tooltip with the name and the 0..3999 coordinates inside the hovered region */
	protected renderHovered(context: CanvasRenderingContext2D, region: Region) {
		if (!this.pointer) return;
		const lines = [
			this.names.get(region.id) ?? `Region #${region.id}`,
			`${Math.floor(region.localX)}, ${Math.floor(region.localY)}`,
		];
		context.font = '16px Tiny5, monospace';
		const boxWidth = Math.max(...lines.map((x) => context.measureText(x).width)) + 16;
		const boxHeight = lines.length * 20 + 12;
		const x = Math.min(this.pointer.x + 16, window.innerWidth - boxWidth - 4);
		const y = Math.min(this.pointer.y + 16, window.innerHeight - boxHeight - 4);

		context.fillStyle = 'rgb(0 0 0 / 75%)';
		context.fillRect(x, y, boxWidth, boxHeight);
		context.lineWidth = 1;
		context.strokeStyle = '#66bbb4';
		context.strokeRect(x + 0.5, y + 0.5, boxWidth, boxHeight);
		context.fillStyle = '#fff';
		for (let index = 0; index < lines.length; index++) context.fillText(lines[index]!, x + 8, y + 6 + index * 20);
	}

	/** Queue a name lookup for a region we haven't seen yet */
	protected requestName(region: Region) {
		if (this.names.has(region.id) || this.requested.has(region.id)) return;
		this.requested.add(region.id);
		this.nameQueue.push(region);
		void this.pumpNames();
	}

	/**
	 * Names come from a single `/s0/pixel/` lookup in the middle of the region.
	 * One at a time with a small gap, so panning around never floods the backend.
	 */
	protected async pumpNames() {
		if (this.fetchingName) return;
		const region = this.nameQueue.pop();
		if (!region) return;
		this.fetchingName = true;
		try {
			const globalX = region.x * REGION_SIZE + REGION_SIZE / 2;
			const globalY = region.y * REGION_SIZE + REGION_SIZE / 2;
			const response = await fetch(
				`https://backend.wplace.live/s0/pixel/${(globalX / WORLD_TILE_SIZE) | 0}/${(globalY / WORLD_TILE_SIZE) | 0}` +
					`?x=${globalX % WORLD_TILE_SIZE}&y=${globalY % WORLD_TILE_SIZE}`
			);
			const data = (await response.json()) as { region?: { name?: string; number?: number } };
			if (data.region?.name) {
				this.names.set(region.id, `${data.region.name} #${data.region.number}`);
				this.saveNames();
				this.update();
			}
		} catch {
			// A failed lookup just means the region stays labelled by id
			this.requested.delete(region.id);
		} finally {
			this.fetchingName = false;
			setTimeout(this.pumpNames.bind(this), 250);
		}
	}

	protected loadNames() {
		try {
			const stored = localStorage.getItem(NAMES_KEY);
			if (!stored) return;
			for (const [id, name] of Object.entries(JSON.parse(stored) as Record<string, string>))
				this.names.set(Number(id), name);
		} catch {
			// Corrupted cache, start over
		}
	}

	protected saveNames() {
		try {
			if (this.names.size > MAX_CACHED_NAMES) this.names.clear();
			localStorage.setItem(NAMES_KEY, JSON.stringify(Object.fromEntries(this.names)));
		} catch {
			// Storage full or blocked, names just won't survive a reload
		}
	}
}
