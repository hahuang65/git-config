export function normalizeIntent(value) {
  const intent = value
    ?.normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!intent) throw new Error("A task intent containing letters or numbers is required");
  return intent;
}
