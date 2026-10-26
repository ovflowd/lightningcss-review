// Ambient declarations for the oracle's dependencies that ship no types. They exist only inside
// the Docker images (playwright, @webref/css) or publish no typings (css-tree, pngjs). Each one
// declares exactly the surface the oracle uses, so tsc checks those calls instead of trusting `any`.

declare module 'css-tree' {
  /** Source offsets of a node (`positions: true`). */
  export interface CssLocation {
    start: { offset: number; line: number; column: number };
    end: { offset: number; line: number; column: number };
  }

  /** css-tree's doubly linked list. `forEach` passes (data, listItem, list), not an index. */
  export interface CssList<T> {
    readonly first: T | null;
    readonly size: number;
    forEach(fn: (data: T, item: { prev: unknown; next: unknown; data: T }, list: CssList<T>) => void): void;
    toArray(): T[];
    push(data: T): void;
  }

  /**
   * Any css-tree AST node. Fields are optional because they depend on `type`; the oracle checks
   * `type` before reading a type-specific field.
   */
  export interface CssNode {
    type: string;
    loc?: CssLocation | null;
    name: string;
    children?: CssList<CssNode> | null;
    prelude?: CssNode | null;
    block?: CssNode | null;
    value?: CssNode | string | null;
    property?: string;
    important?: boolean | string;
    matcher?: string | null;
    nth?: CssNode | null;
    a?: string | null;
    b?: string | null;
  }

  /** The `this` of a parser method (Block.parse), with the helpers the nested-rule parser uses. */
  export interface CssParser {
    tokenType: number;
    tokenStart: number;
    eof: boolean;
    substring(start: number, end: number): string;
    lookupType(offset: number): number;
    next(): void;
    eat(tokenType: number): void;
    createList(): CssList<CssNode>;
    getLocation(start: number, end: number): CssLocation | null;
    parseWithFallback(consumer: () => CssNode, fallback: () => CssNode): CssNode;
    consumeUntilSemicolonIncluded: (code: number) => number;
    Raw(consumeUntil: ((code: number) => number) | null, excludeWhiteSpace: boolean): CssNode;
    Atrule(isDeclaration: boolean): CssNode;
    Rule(): CssNode;
    Declaration(): CssNode;
  }

  export interface ParseOptions {
    positions?: boolean;
    parseValue?: boolean;
    parseCustomProperty?: boolean;
    onParseError?: (error: unknown) => void;
  }

  export interface WalkOptions {
    visit?: string;
    enter?: (node: CssNode) => void;
    leave?: (node: CssNode) => void;
  }

  /** A forked syntax: the same parse/generate with custom node parsers. */
  export interface CssSyntax {
    parse(source: string, options?: ParseOptions): CssNode;
    generate(node: CssNode): string;
  }

  export const tokenTypes: Record<
    | 'EOF'
    | 'Ident'
    | 'Function'
    | 'AtKeyword'
    | 'WhiteSpace'
    | 'Comment'
    | 'Semicolon'
    | 'LeftParenthesis'
    | 'RightParenthesis'
    | 'LeftSquareBracket'
    | 'RightSquareBracket'
    | 'LeftCurlyBracket'
    | 'RightCurlyBracket',
    number
  >;
  export function parse(source: string, options?: ParseOptions): CssNode;
  export function generate(node: CssNode): string;
  export function walk(ast: CssNode, options: WalkOptions | ((node: CssNode) => void)): void;
  export function fork(extension: {
    node: Record<string, { parse: (this: CssParser, ...args: never[]) => CssNode }>;
  }): CssSyntax;
  export const ident: { decode(text: string): string };
  export const string: { decode(text: string): string };
}

declare module 'pngjs' {
  /** A decoded image: RGBA bytes, row by row. */
  export interface DecodedPng {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export const PNG: { sync: { read(buffer: Uint8Array): DecodedPng } };
}

declare module 'playwright' {
  export interface ElementHandle {
    screenshot(): Promise<Uint8Array>;
  }

  export interface Page {
    setContent(html: string): Promise<void>;
    evaluate<R, A>(pageFunction: (arg: A) => R, arg: A): Promise<R>;
    evaluate<R>(pageFunction: () => R): Promise<R>;
    emulateMedia(options: { colorScheme: 'light' | 'dark' }): Promise<void>;
    $(selector: string): Promise<ElementHandle | null>;
    close(): Promise<void>;
  }

  export interface BrowserContext {
    newPage(): Promise<Page>;
  }

  export interface Browser {
    version(): string;
    newContext(options: {
      viewport: { width: number; height: number };
      deviceScaleFactor: number;
      colorScheme: 'light' | 'dark';
    }): Promise<BrowserContext>;
    close(): Promise<void>;
  }

  export interface BrowserType {
    launch(): Promise<Browser>;
  }

  export const chromium: BrowserType;
  export const firefox: BrowserType;
  export const webkit: BrowserType;
}

declare module '@webref/css' {
  /** One entry of a webref list (property, type, function, at-rule or selector). */
  export interface WebrefEntry {
    name: string;
    href?: string;
    syntax?: string;
    initial?: string;
    inherited?: string;
    computedValue?: string;
    animationType?: string;
    percentages?: string;
    appliesTo?: string;
    canonicalOrder?: string;
    longhands?: string[];
    legacyAliasOf?: string;
    descriptors?: { name: string }[];
  }

  export interface WebrefData {
    properties: WebrefEntry[];
    types?: WebrefEntry[];
    functions?: WebrefEntry[];
    atrules?: WebrefEntry[];
    selectors?: WebrefEntry[];
  }

  const css: { listAll(): Promise<WebrefData> };

  export default css;
}
