export function nextOffset(offset: number, limit: number): number {
  return offset + limit;
}

export function previousOffset(offset: number, limit: number): number {
  return Math.max(0, offset - limit);
}

export function hasNextPage(offset: number, limit: number, total: number): boolean {
  return offset + limit < total;
}
