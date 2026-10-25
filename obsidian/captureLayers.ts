/**
 * Layer selection for renderers that paint one picture as several stacked
 * elements. Plotly, for example, draws the plot in the first `svg.main-svg`,
 * the legend, titles, annotations and colour bars in a second one on top, and
 * WebGL traces in canvases between them. Capturing only the first SVG drops
 * everything in the upper layers.
 *
 * This module holds no DOM access so the rules can be tested with ts-node.
 */

export interface LayerBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface LayerCandidate extends LayerBox {
    kind: 'svg' | 'canvas';
    /** False for display:none, visibility:hidden or opacity 0. */
    visible: boolean;
}

export interface LayerStack {
    /** Indices into the candidates, in paint (DOM) order. */
    indices: number[];
    bounds: LayerBox;
}

/** A layer joins the stack when at least this share of its area overlaps the base layer. */
const MIN_OVERLAP_RATIO = 0.5;

/**
 * Picks the sibling layers painted over the base layer. Candidates must be in
 * DOM order; the base is always kept. Layers placed beside the base (another
 * diagram, a toolbar) overlap it too little and are left out.
 */
export function selectLayerStack(candidates: LayerCandidate[], baseIndex: number): LayerStack {
    const base = candidates[baseIndex];
    const indices: number[] = [];
    for (const [index, candidate] of candidates.entries()) {
        if (index === baseIndex || (candidate.visible && hasArea(candidate) && overlapRatio(candidate, base) >= MIN_OVERLAP_RATIO)) {
            indices.push(index);
        }
    }
    return { indices, bounds: unionBox(indices.map((index) => candidates[index])) };
}

/** True for CSS colours that paint nothing, such as a layer's default background. */
export function isTransparentColor(value: string): boolean {
    const color = value.trim().toLowerCase();
    if (!color || color === 'transparent' || color === 'none') return true;
    const alpha = /^rgba\(.*,\s*([\d.]+%?)\s*\)$/.exec(color) ?? /^rgba?\(.*\/\s*([\d.]+%?)\s*\)$/.exec(color);
    return alpha !== null && Number.parseFloat(alpha[1]) === 0;
}

function hasArea(box: LayerBox): boolean {
    return box.width > 0 && box.height > 0;
}

function overlapRatio(box: LayerBox, base: LayerBox): number {
    const width = Math.min(box.left + box.width, base.left + base.width) - Math.max(box.left, base.left);
    const height = Math.min(box.top + box.height, base.top + base.height) - Math.max(box.top, base.top);
    if (width <= 0 || height <= 0) return 0;
    return (width * height) / (box.width * box.height);
}

function unionBox(boxes: LayerBox[]): LayerBox {
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.left + box.width));
    const bottom = Math.max(...boxes.map((box) => box.top + box.height));
    return { left, top, width: right - left, height: bottom - top };
}
