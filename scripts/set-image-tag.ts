const [file, tag] = Bun.argv.slice(2);
if (!file || !tag) throw new Error("usage: bun scripts/set-image-tag.ts <values-file> <tag>");
const source = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
const block = /^image:\n((?: {2}.*\n)*)/m;
const match = source.match(block);
let output: string;
if (!match) {
  output = `image:\n  tag: "${tag}"\n${source}`;
} else {
  const body = match[1] ?? "";
  const nextBody = /^ {2}tag:.*$/m.test(body)
    ? body.replace(/^ {2}tag:.*$/m, `  tag: "${tag}"`)
    : `${body}  tag: "${tag}"\n`;
  output = source.replace(block, `image:\n${nextBody}`);
}
await Bun.write(file, output);
