import type { PdfPageRotation, PdfPageState } from '@/types/notebook';

export type { PdfPageRotation, PdfPageState };

const rotations: PdfPageRotation[] = [0, 90, 180, 270];

export function normalizePdfPageState(state: PdfPageState | undefined, pageCount: number): PdfPageState {
  const source = Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1);
  const order = state?.pageOrder?.filter(page => source.includes(page)) ?? [];
  for (const page of source) if (!order.includes(page)) order.push(page);
  const nextRotations: Record<number, PdfPageRotation> = {};
  for (const page of source) {
    const rotation = state?.rotations?.[page];
    if (rotations.includes(rotation as PdfPageRotation) && rotation !== 0) nextRotations[page] = rotation as PdfPageRotation;
  }
  return { version: 1, pageOrder: order, rotations: nextRotations };
}
