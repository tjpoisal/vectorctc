# Third-party notices

VectorCTC is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`). It ships the following third-party material in its npm package.

## Bundled files

### tree-sitter-python grammar (`data/grammars/tree-sitter-python.wasm`)

Built from https://github.com/tree-sitter/tree-sitter-python (via the `tree-sitter-wasms@0.1.13` build). License:

```
The MIT License (MIT)

Copyright (c) 2016 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tree-sitter-go grammar (`data/grammars/tree-sitter-go.wasm`)

Built from https://github.com/tree-sitter/tree-sitter-go (via the `tree-sitter-wasms@0.1.13` build). License:

```
The MIT License (MIT)

Copyright (c) 2014 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Vulnerability advisories (`data/osv-seed.json`)

A snapshot of advisories fetched from the OSV database (https://osv.dev, api.osv.dev) on 2026-11-24, mostly GitHub
Security Advisories (GHSA). OSV and the GitHub Advisory Database publish this data under the
Creative Commons Attribution 4.0 International License (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/);
individual records may carry their own source's terms. Records are trimmed to id, aliases, summary, severity and
affected ranges; no other changes were made.

## Runtime dependencies (installed by npm, not bundled)

As of 0.5.0 the production dependency tree is all permissive and Apache-2.0-compatible: MIT (97 packages), ISC (7),
BlueOak-1.0.0 (2: minimatch, @isaacs/nonrecursive-glob-match), BSD-3-Clause (2: fast-uri, qs), BSD-2-Clause
(1: json-schema-typed). Direct dependencies: @modelcontextprotocol/sdk (MIT), commander (MIT), minimatch (BlueOak-1.0.0),
ts-morph (MIT), web-tree-sitter (MIT), zod (MIT).
