const DEFAULT_CAPACITY = 4;

export function readTreehouseCapacity(value = process.env.TREEHOUSE_MAX_TREES) {
  if (value === undefined || value === "") return DEFAULT_CAPACITY;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("TREEHOUSE_MAX_TREES must be a positive integer");
  }
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity)) {
    throw new Error("TREEHOUSE_MAX_TREES must be a positive integer");
  }
  return capacity;
}
