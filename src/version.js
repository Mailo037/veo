// Shared semver-ish comparison for veo releases and yt-dlp release dates.
export function compareVersions(a, b) {
  const parse = value => {
    const [core, pre = ''] = String(value).trim().replace(/^v/, '').split('-');
    if (!/^\d+(\.\d+)*$/.test(core)) throw new Error(`Invalid version: ${value}`);
    // Semver prerelease identifiers compare per segment, numerically when numeric.
    return { parts: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  // A release outranks any prerelease of the same core version.
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      const difference = Number(l) - Number(r);
      if (difference) return Math.sign(difference);
    } else if (lNumeric) return -1; // Numeric identifiers rank below alphanumerics.
    else if (rNumeric) return 1;
    else if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}
