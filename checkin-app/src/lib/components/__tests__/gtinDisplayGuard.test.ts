/** @jest-environment node */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Fails on a GTIN rendered as a JSX child without formatGtinDisplay.
 *
 * ponytail: syntax only, by the name `gtin13`. A renamed variable or a value copied into a
 * local before rendering is not seen; use the type checker if that bites.
 */
const GTIN_NAME = /gtin13$/i;
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function rawGtins(node: ts.Node, found: ts.Node[]): void {
  if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
    const name = ts.isIdentifier(node) ? node.text : node.name.text;
    if (GTIN_NAME.test(name)) found.push(node);
    else if (ts.isPropertyAccessExpression(node)) rawGtins(node.expression, found);
    return;
  }
  // A call's arguments are its own business, so only the receiver and any callback can render a value.
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression)) rawGtins(node.expression.expression, found);
    for (const arg of node.arguments) if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) rawGtins(arg.body, found);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    rawGtins(node.whenTrue, found);
    rawGtins(node.whenFalse, found);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (COMPARISONS.has(node.operatorToken.kind)) return;
    if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) rawGtins(node.left, found);
    rawGtins(node.right, found);
    return;
  }
  if (ts.isJsxAttribute(node) || ts.isVariableDeclaration(node) || ts.isElementAccessExpression(node)) return;
  ts.forEachChild(node, (child) => rawGtins(child, found));
}

/** Source text of each raw GTIN a JSX child renders. */
function rawGtinsInJsx(source: string): string[] {
  const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) rawGtins(node.expression, found);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)].map((node) => node.getText());
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'generated') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('a GTIN rendered in JSX', () => {
  it.each([
    ['<p>{l.gtin13}</p>'],
    ['<p>{l.gtin13 ?? "-"}</p>'],
    ['<p>{a && b.assignedGtin13}</p>'],
    ['<p>{x ? l.gtin13 : "-"}</p>'],
    ['<p>{`${n} × ${l.gtin13}`}</p>'],
    ['<p>{rows.map((l) => l.gtin13).join(", ")}</p>'],
    ['<p>{rows.map((l) => <b>{l.gtin13}</b>)}</p>'],
    ['<p>{gtin13}</p>'],
  ])('is caught when raw: %s', (source) => {
    expect(rawGtinsInJsx(source)).not.toEqual([]);
  });

  it.each([
    ['<p>{formatGtinDisplay(l.gtin13)}</p>'],
    ['<p>{l.gtin13 ? formatGtinDisplay(l.gtin13) : "-"}</p>'],
    ['<p>{l.gtin13 && formatGtinDisplay(l.gtin13)}</p>'],
    ['<p>{l.gtin13 === x ? "same" : "other"}</p>'],
    ['<p>{names.get(l.gtin13)}</p>'],
    ['<p key={l.gtin13} data-id={l.gtin13}>name</p>'],
    ['<TextInput value={gtin13} onChange={(e) => setGtin13(e.target.value)} />'],
  ])('is allowed when formatted or not rendered: %s', (source) => {
    expect(rawGtinsInJsx(source)).toEqual([]);
  });

  it('never appears raw in the app or a library', () => {
    const repo = join(process.cwd(), '..');
    const packages = join(repo, 'packages');
    const roots = [
      join(process.cwd(), 'src'),
      ...readdirSync(packages).map((name) => join(packages, name, 'src')).filter((dir) => {
        try { return readdirSync(dir).length > 0; } catch { return false; }
      }),
    ];
    const offenders = roots.flatMap(tsxFiles).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /gtin13/i.test(source)
        ? rawGtinsInJsx(source).map((text) => `${relative(repo, path)}: ${text}`)
        : [];
    });
    expect(offenders).toEqual([]);
  });
});
