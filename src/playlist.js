export function validateItems(value) {
  if (typeof value !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) {
    throw new Error('--playlist-items expects positive indices or ranges, e.g. 1,3-5.');
  }
  for (const part of value.split(',')) {
    const [start, end = start] = part.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('--playlist-items requires ascending, positive ranges.');
    }
  }
  return value;
}

export function selectedEntries(metadata, selection) {
  const ranges = selection ? validateItems(selection).split(',').map(part => part.split('-').map(Number)) : null;
  const entries = (metadata.entries || []).map((entry, offset) => ({ entry, index: entry?.playlist_index || offset + 1 }));
  const selected = entries.filter(({ index }) => !ranges || ranges.some(([start, end = start]) => index >= start && index <= end));
  if (!selected.length) throw new Error('No playlist entries match the selection.');
  return selected;
}

export function sizeEstimate(entries) {
  const sizes = entries.map(({ entry }) => entry?.filesize || entry?.filesize_approx);
  const known = sizes.filter(value => Number.isFinite(value) && value > 0);
  return { estimatedBytes: known.reduce((sum, value) => sum + value, 0), knownSizes: known.length, totalEntries: entries.length };
}

export function describeEstimate(estimate) {
  if (!estimate.knownSizes) return `${estimate.totalEntries} entries; total size unknown`;
  return `${estimate.totalEntries} entries; approximately ${(estimate.estimatedBytes / 1048576).toFixed(1)} MiB${estimate.knownSizes < estimate.totalEntries ? ` for ${estimate.knownSizes} entries; remaining sizes unknown` : ''}`;
}
