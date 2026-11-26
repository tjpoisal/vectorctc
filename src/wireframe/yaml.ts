/**
 * Tiny YAML subset for wireframe specs: nested maps, "- " lists, inline [a, b] lists, quoted or plain
 * scalars, numbers, booleans and # comments. No anchors, multi-line strings or flow maps; use JSON for those.
 */
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

function scalar(raw: string): Value {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).split(",").map((item) => scalar(item)).filter((item) => item !== null);
  return text;
}

interface Line {
  indent: number;
  text: string;
}

export function parseYaml(source: string): Value {
  const lines: Line[] = source
    .split("\n")
    .map((raw) => raw.replace(/\s+#.*$/, "").replace(/^#.*$/, ""))
    .filter((raw) => raw.trim() !== "")
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  let index = 0;
  function block(indent: number): Value {
    const first = lines[index];
    if (!first) return null;
    if (first.text.startsWith("- ") || first.text === "-") {
      const list: Value[] = [];
      while (index < lines.length && (lines[index]?.indent ?? -1) === indent && (lines[index]?.text.startsWith("-") ?? false)) {
        const line = lines[index] as Line;
        const rest = line.text.replace(/^-\s*/, "");
        index += 1;
        if (rest === "") list.push(block((lines[index]?.indent ?? indent + 2)));
        else if (/^[\w$-]+\s*:/.test(rest) && !/^\w+:\/\//.test(rest)) {
          // "- key: value" starts a map item; following keys are indented past the dash.
          lines.splice(index, 0, { indent: indent + 2, text: rest });
          list.push(block(indent + 2));
        } else list.push(scalar(rest));
      }
      return list;
    }
    const map: { [key: string]: Value } = {};
    while (index < lines.length && (lines[index]?.indent ?? -1) === indent) {
      const line = lines[index] as Line;
      const match = line.text.match(/^([^:]+?)\s*:\s*(.*)$/);
      if (!match?.[1]) throw new Error(`Cannot parse YAML line: ${line.text}`);
      index += 1;
      const key = match[1].replace(/^["']|["']$/g, "");
      if ((match[2] ?? "") !== "") map[key] = scalar(match[2] ?? "");
      else if (index < lines.length && (lines[index]?.indent ?? 0) > indent) map[key] = block(lines[index]?.indent ?? indent + 2);
      else if (index < lines.length && (lines[index]?.indent ?? 0) === indent && lines[index]?.text.startsWith("-")) map[key] = block(indent);
      else map[key] = null;
    }
    return map;
  }
  return block(lines[0]?.indent ?? 0);
}
