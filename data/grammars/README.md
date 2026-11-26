# Vendored tree-sitter grammars

`tree-sitter-python.wasm` and `tree-sitter-go.wasm` are copied unmodified from the npm package
[`tree-sitter-wasms@0.1.13`](https://github.com/Gregoor/tree-sitter-wasms) (Unlicense build), built from
[tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) and
[tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) (both MIT). They load with `web-tree-sitter@0.25.10`.
Only these two grammars are vendored to keep the package small (about 700 KB instead of 50 MB).

The GitHub repository stores them as base64 text (`*.wasm.b64`) because it was published through a text-only API;
`src/lang/treesitter.ts` decodes those when the `.wasm` file is absent. The npm package ships the `.wasm` files.
