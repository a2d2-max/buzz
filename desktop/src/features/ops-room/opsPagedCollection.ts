export type ImmutableOpsPageItem = {
  id: string;
  representation?: string | null;
  version: number;
};

function immutableKey(item: ImmutableOpsPageItem): string {
  return `${item.id}\u0000${item.version}\u0000${item.representation ?? ""}`;
}

export function mergeImmutableOpsPage<T extends ImmutableOpsPageItem>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(current.map(immutableKey));
  return [
    ...current,
    ...next.filter((item) => {
      const key = immutableKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
