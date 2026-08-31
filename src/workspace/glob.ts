function escapeRegexCharacter(character: string): string {
  return /[\\^$+?.()|{}[\]]/u.test(character) ? `\\${character}` : character;
}

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character !== "*") {
      source += escapeRegexCharacter(character);
      continue;
    }

    if (pattern[index + 1] === "*") {
      index += 1;
      while (pattern[index + 1] === "*") index += 1;
      if (pattern[index + 1] === "/") {
        source += "(?:.*/)?";
        index += 1;
      } else {
        source += ".*";
      }
    } else {
      source += "[^/]*";
    }
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "iu" : "u");
}
