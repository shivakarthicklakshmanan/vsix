/**
 * markdown.test.js
 * Covers the renderer that replaced the code-fences-only `renderMarkdownish`.
 *
 * The headline case is the one visible in the user's screen recording, where the
 * panel printed a literal "**Key Features of Python**" instead of bold text.
 *
 * Run: node test/markdown.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load the browser-targeted renderer into a sandbox with a fake `window`.
const src = fs.readFileSync(
  path.join(__dirname, "..", "media", "webview", "markdown.js"),
  "utf8"
);
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { render } = sandbox.window.TechMindMarkdown;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("renders bold — the exact failure in the recording", () => {
  const html = render("**Key Features of Python**");
  assert.ok(html.includes("<strong>Key Features of Python</strong>"), html);
  assert.ok(!html.includes("**"), "no literal asterisks should survive");
});

test("renders bold inside a list item", () => {
  const html = render("* **Easy to learn**: Python has a simple syntax.");
  assert.ok(html.includes("<ul>"), html);
  assert.ok(html.includes("<strong>Easy to learn</strong>"), html);
  assert.ok(!html.includes("**"), html);
});

test("renders headings", () => {
  assert.ok(render("## Key Features").includes("<h2>Key Features</h2>"));
  assert.ok(render("#### Deep").includes("<h4>Deep</h4>"));
});

test("renders ordered lists", () => {
  const html = render("1. first\n2. second");
  assert.ok(html.includes("<ol>"), html);
  assert.ok(html.includes("<li>first</li>"), html);
});

test("renders tables", () => {
  const html = render("| A | B |\n|---|---|\n| 1 | 2 |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<th>A</th>"), html);
  assert.ok(html.includes("<td>2</td>"), html);
  assert.ok(html.includes("table-wrap"), "wide tables must scroll in their own box");
});

test("preserves fenced code verbatim and does not emphasise inside it", () => {
  const html = render("```python\nx = a ** b\nprint('**hi**')\n```");
  assert.ok(html.includes("<pre"), html);
  assert.ok(html.includes('class="lang-python"'), html);
  assert.ok(html.includes("x = a ** b"), "code must not be emphasis-parsed");
  assert.ok(!html.includes("<strong>"), html);
});

test("renders inline code without emphasising its contents", () => {
  const html = render("call `foo(**kwargs)` now");
  assert.ok(html.includes("<code>foo(**kwargs)</code>"), html);
  assert.ok(!html.includes("<strong>"), html);
});

test("escapes HTML so model output cannot inject markup", () => {
  const html = render('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"), html);
});

test("escapes HTML inside fenced code too", () => {
  const html = render("```html\n<script>alert(1)</script>\n```");
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

test("renders links as plain text (nothing to browse to offline)", () => {
  const html = render("see [the docs](https://example.com/x)");
  assert.ok(html.includes("the docs"), html);
  assert.ok(!html.includes("<a "), html);
  assert.ok(!html.includes("example.com"), html);
});

test("handles blockquotes and rules", () => {
  assert.ok(render("> quoted").includes("<blockquote>"));
  assert.ok(render("---").includes("<hr>"));
});

test("renders a realistic mixed response", () => {
  const html = render(
    "## Summary\n\nPython is **easy**.\n\n" +
      "* **Interpreted**: runs line by line\n* Has a `stdlib`\n\n" +
      "```python\nprint('hi')\n```\n\n" +
      "| Year | Version |\n|---|---|\n| 1991 | 0.9.1 |\n"
  );
  assert.ok(html.includes("<h2>Summary</h2>"), html);
  assert.ok(html.includes("<strong>easy</strong>"), html);
  assert.ok(html.includes("<ul>"), html);
  assert.ok(html.includes("<pre"), html);
  assert.ok(html.includes("<table>"), html);
  assert.ok(!html.includes("**"), "no stray asterisks anywhere");
});

test("empty input is safe", () => {
  assert.strictEqual(render(""), "");
  assert.strictEqual(render(null), "");
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e && e.message}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
