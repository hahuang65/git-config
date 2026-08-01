const DEFAULT_CAPACITY = 4;

export function readOrchardCapacity(value = process.env.ORCHARD_MAX_TREES) {
  if (value === undefined || value === "") return DEFAULT_CAPACITY;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("ORCHARD_MAX_TREES must be a positive integer");
  }
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity)) {
    throw new Error("ORCHARD_MAX_TREES must be a positive integer");
  }
  return capacity;
}
