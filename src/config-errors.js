// Diagnose syntax without echoing config values (which can include private paths).
export function configSyntaxError(text, file, original) {
  let index = 0;
  const fail = reason => { throw { reason, position: index }; };
  const space = () => { while (/\s/.test(text[index] || '') && index < text.length) index++; };
  function string() {
    index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return;
      if (char.charCodeAt(0) < 32) { index--; fail('Unescaped line break or control character inside a string.'); }
      if (char === '\\') {
        const escape = text[index];
        if (escape === 'u') {
          index++;
          for (let count = 0; count < 4; count++, index++) {
            if (!/[0-9a-f]/i.test(text[index] || '')) fail('Invalid Unicode escape; use four hexadecimal digits after \\u.');
          }
        } else if (escape && '"\\/bfnrt'.includes(escape)) index++;
        else fail('Invalid escape sequence. For Windows paths, use forward slashes (G:/Videos) or double backslashes (G:\\\\Videos).');
      }
    }
    fail('Unterminated string; add a closing double quote.');
  }
  function value() {
    space();
    const char = text[index];
    if (char === '`') fail('Markdown code fences are not valid JSON. Remove the lines containing ```json and ```.');
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{', close = object ? '}' : ']';
      index++; space();
      if (text[index] === close) { index++; return; }
      while (true) {
        space();
        if (text[index] === '`') fail('Markdown code fences are not valid JSON. Remove the lines containing ```json and ```.');
        if (object) {
          if (text[index] !== '"') fail('Expected a property name in double quotes. Check for a trailing comma or a missing closing brace.');
          string(); space();
          if (text[index++] !== ':') { index--; fail('Expected a colon (:) after the property name.'); }
        }
        value(); space();
        if (text[index] === close) { index++; return; }
        if (text[index] !== ',') fail(`Expected a comma (,) or closing ${close}.`);
        index++; space();
        if (text[index] === close) fail('Trailing commas are not allowed. Remove the comma before the closing bracket or brace.');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!literal) fail('Expected a JSON value: object, array, string, number, true, false or null.');
    index += literal[0].length;
  }
  let issue;
  if (Number.isInteger(original?.position)) issue = { position: original.position, reason: original.message };
  else {
    try { value(); space(); if (index !== text.length) fail('Unexpected content after the JSON value. Remove extra text or Markdown code fences.'); }
    catch (error) { issue = error; }
  }
  const position = Math.min(issue?.position ?? index, text.length);
  const preceding = text.slice(0, position);
  const line = preceding.split('\n').length;
  const column = position - preceding.lastIndexOf('\n');
  return new Error(`The veo config file is not valid JSON: ${file} (line ${line}, column ${column}). ${issue?.reason || 'Invalid JSON syntax.'}`);
}
