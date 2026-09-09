// ANSI colour helpers. Every MUD needs a palette; this is ours.

const wrap = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const magenta = wrap('35');
export const cyan = wrap('36');
export const brightCyan = wrap('1;36');
export const brightMagenta = wrap('1;35');
