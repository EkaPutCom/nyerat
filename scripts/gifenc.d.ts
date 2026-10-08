// gifenc (used by scripts/capture.ts) does not ship types.
declare module 'gifenc' {
    export interface GifEncoder {
        writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number }): void;
        finish(): void;
        bytes(): Uint8Array;
    }
    export function GIFEncoder(): GifEncoder;
    export function quantize(rgba: Uint8Array, maxColors: number): number[][];
    export function applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
}
