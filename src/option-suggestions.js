// Match misspelled flags without silently accepting them. Ignore punctuation
// differences first, then allow a small number of insertions or transpositions.
function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i++) rows[i][0] = i;
  for (let j = 0; j <= right.length; j++) rows[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[left.length][right.length];
}

export function suggestOption(unknown, options) {
  const normalized = value => value.toLowerCase().replace(/-/g, '');
  const target = normalized(unknown);
  const prefix = unknown.startsWith('--') ? '--' : unknown.startsWith('-') ? '-' : null;
  const candidates = [...new Set(options)].filter(option => prefix ? option.startsWith(prefix) : !option.startsWith('-'));
  const ranked = candidates.map(option => ({ option, distance: editDistance(target, normalized(option)) }))
    .sort((a, b) => a.distance - b.distance || a.option.length - b.option.length);
  const best = ranked[0];
  return best && best.distance <= Math.min(3, Math.max(1, Math.floor(target.length / 3))) ? best.option : null;
}

export function optionSpellings(schema) {
  return Object.entries(schema).flatMap(([name, details]) => [
    `--${name}`, ...(details.short ? [`-${details.short}`] : []),
    ...(details.type === 'boolean' ? [`--no-${name}`] : []),
  ]);
}

export function explainUnknownOption(error, schema) {
  if (error?.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return error;
  const unknown = /Unknown option '([^']+)'/.exec(error.message)?.[1];
  if (!unknown) return error;
  const suggestion = suggestOption(unknown, optionSpellings(schema));
  return new Error(`Unknown option "${unknown}".${suggestion ? ` Did you mean "${suggestion}"?` : ' Run veo --help to see available options.'}`, { cause: error });
}
