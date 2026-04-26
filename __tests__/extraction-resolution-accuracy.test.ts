/**
 * Extraction & Resolution Accuracy Tests
 *
 * Regression tests for three accuracy bugs fixed in one PR:
 *   1. Parse-retry comment strip was hardcoded to `//`, no-op on Python/Ruby/etc.
 *   2. Framework route extractors ran regex over raw file content, matching
 *      examples in docstrings/comments as real routes.
 *   3. UTF-8 BOM caused spurious "modified" hash mismatches between editors.
 */

import { describe, it, expect } from 'vitest';
import { stripBom, stripCommentLinesForRetry, stripCommentsForRegex } from '../src/utils';
import { hashContent } from '../src/extraction';
import { flaskResolver, fastapiResolver, djangoResolver } from '../src/resolution/frameworks/python';
import { expressResolver } from '../src/resolution/frameworks/express';
import { aspnetResolver } from '../src/resolution/frameworks/csharp';
import { rustResolver } from '../src/resolution/frameworks/rust';
import { laravelResolver } from '../src/resolution/frameworks/laravel';

describe('UTF-8 BOM normalization (bug #5)', () => {
  it('stripBom removes leading U+FEFF', () => {
    expect(stripBom('﻿hello')).toBe('hello');
    expect(stripBom('hello')).toBe('hello');
    expect(stripBom('')).toBe('');
  });

  it('stripBom only removes leading BOM, not embedded ones', () => {
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });

  it('hashContent treats BOM and no-BOM as identical', () => {
    const withBom = '﻿export function hello() { return 42; }';
    const withoutBom = 'export function hello() { return 42; }';
    expect(hashContent(withBom)).toBe(hashContent(withoutBom));
  });
});

describe('Per-language comment-line stripping (bug #1)', () => {
  it('strips `#` lines for Python', () => {
    const input = ['# CHECK: foo', 'def x():', '    pass'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n')).toEqual(['', 'def x():', '    pass']);
  });

  it('strips `#` lines for Ruby', () => {
    const input = ['# top comment', 'def x; end'].join('\n');
    const out = stripCommentLinesForRetry(input, 'ruby');
    expect(out.split('\n')).toEqual(['', 'def x; end']);
  });

  it('strips `//` lines for TypeScript', () => {
    const input = ['// header', 'function x() {}'].join('\n');
    const out = stripCommentLinesForRetry(input, 'typescript');
    expect(out.split('\n')).toEqual(['', 'function x() {}']);
  });

  it('strips both `//` and `#` lines for PHP', () => {
    const input = ['// js-style', '# perl-style', '<?php $x = 1;'].join('\n');
    const out = stripCommentLinesForRetry(input, 'php');
    expect(out.split('\n')).toEqual(['', '', '<?php $x = 1;']);
  });

  it('returns content unchanged for unknown languages', () => {
    const input = '// looks like a comment\ncode';
    expect(stripCommentLinesForRetry(input, 'unknown-lang')).toBe(input);
  });

  it('preserves line count so node positions stay correct', () => {
    const input = ['# c1', 'a', '# c2', 'b'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n').length).toBe(input.split('\n').length);
  });

  it('does NOT strip indented `#` inside Python (still recognized as line comment)', () => {
    // The marker matches optional leading whitespace + `#`, so an indented
    // pure comment line is correctly stripped. Non-comment code on the same
    // line as `#` (mid-line comment) is intentionally not stripped here.
    const input = ['    # indented comment', '    pass  # trailing'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n')).toEqual(['', '    pass  # trailing']);
  });
});

describe('Framework regex no longer matches docstrings/comments (bug #4)', () => {
  describe('Flask', () => {
    it('skips routes inside `#` comments', () => {
      const content = [
        'from flask import Flask',
        'app = Flask(__name__)',
        '# Example: @app.route("/fake")',
        '@app.route("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = flaskResolver.extractNodes!('app.py', content);
      const paths = nodes.map((n) => n.name);
      expect(paths).toContain('/real');
      expect(paths).not.toContain('/fake');
    });

    it('skips routes inside triple-quoted docstrings', () => {
      const content = [
        'def example():',
        '    """',
        '    Usage: @app.route("/fake")',
        '    """',
        '    pass',
        '@app.route("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = flaskResolver.extractNodes!('app.py', content);
      const paths = nodes.map((n) => n.name);
      expect(paths).toContain('/real');
      expect(paths).not.toContain('/fake');
    });
  });

  describe('FastAPI', () => {
    it('skips routes inside `#` comments and triple-quoted docstrings', () => {
      const content = [
        '"""',
        'Module docs — example: @app.get("/docfake")',
        '"""',
        '# @app.post("/commentfake")',
        '@app.get("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = fastapiResolver.extractNodes!('app.py', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
      expect(names.some((n) => n.includes('/commentfake'))).toBe(false);
    });

    it('preserves correct line numbers for real routes after stripping', () => {
      const content = [
        '"""',                    // line 1
        '@app.get("/fake")',      // line 2 — inside docstring
        '"""',                    // line 3
        '',                       // line 4
        '@app.get("/real")',      // line 5 — real
      ].join('\n');
      const nodes = fastapiResolver.extractNodes!('app.py', content);
      const real = nodes.find((n) => n.name.includes('/real'));
      expect(real).toBeDefined();
      expect(real!.startLine).toBe(5);
    });
  });

  describe('Django URL patterns', () => {
    it('skips path() inside `#` comments', () => {
      const content = [
        'from django.urls import path',
        '# example: path("fake/", fake_view)',
        'urlpatterns = [path("real/", real_view)]',
      ].join('\n');
      const nodes = djangoResolver.extractNodes!('urls.py', content);
      const names = nodes.map((n) => n.name);
      expect(names).toContain('real/');
      expect(names).not.toContain('fake/');
    });
  });

  describe('Express', () => {
    it('skips routes inside `//` comments', () => {
      const content = [
        'const app = express();',
        '// app.get("/fake", fakeHandler);',
        'app.get("/real", realHandler);',
      ].join('\n');
      const nodes = expressResolver.extractNodes!('server.js', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/fake'))).toBe(false);
    });

    it('skips routes inside `/* ... */` block comments', () => {
      const content = [
        '/*',
        ' * app.post("/blockfake", h);',
        ' */',
        'app.get("/real", h);',
      ].join('\n');
      const nodes = expressResolver.extractNodes!('server.js', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/blockfake'))).toBe(false);
    });
  });

  describe('Laravel', () => {
    it('skips routes inside PHP `//` and `#` comments', () => {
      const content = [
        '<?php',
        '// Route::get("/jsfake", $h);',
        '# Route::get("/perlfake", $h);',
        'Route::get("/real", $h);',
      ].join('\n');
      const nodes = laravelResolver.extractNodes!('routes.php', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/jsfake'))).toBe(false);
      expect(names.some((n) => n.includes('/perlfake'))).toBe(false);
    });
  });

  describe('Rust', () => {
    it('skips actix/rocket routes inside `///` doc comments', () => {
      const content = [
        '/// Example route: #[get("/docfake")]',
        '#[get("/real")]',
        'fn real() {}',
      ].join('\n');
      const nodes = rustResolver.extractNodes!('main.rs', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
    });
  });

  describe('ASP.NET (C#)', () => {
    it('skips route attributes inside `///` XML doc comments', () => {
      const content = [
        '/// <summary>',
        '/// Example: [HttpGet("/docfake")]',
        '/// </summary>',
        '[HttpGet("/real")]',
        'public class C {}',
      ].join('\n');
      const nodes = aspnetResolver.extractNodes!('Controller.cs', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
    });
  });
});

describe('stripCommentsForRegex preserves line offsets', () => {
  it('keeps newlines so match.index → original line number', () => {
    const input = '"""\n@app.get("/x")\n"""\n@app.get("/y")';
    const out = stripCommentsForRegex(input, 'python');
    // Newlines preserved
    expect(out.split('\n').length).toBe(input.split('\n').length);
    // The /y route survives
    expect(out).toContain('/y');
    // The docstring contents are blanked
    expect(out).not.toContain('/x');
  });
});
