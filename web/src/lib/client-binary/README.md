# Client-side binary metadata

The Agent inspects binary attachments in the browser with `binary_analyzer.wasm`.
The parser accepts only a bounded 64 KiB prefix and recognizes WebAssembly,
ELF, PE, Mach-O, and ZIP signatures. It reports a small metadata summary; it
does not execute the file, unpack archives, or return file bytes.

The model receives that summary only after the user attaches the file to a
message. Images keep their existing image path, while text and selectable PDF
content are extracted in the browser. Unknown binary formats are reported as
unknown without exposing their contents.

The WASM module has no network, filesystem, or cookie imports. The C source and
its no-import boundary are covered by browser-runtime tests. The standard web
build and test scripts generate the module with LLVM `clang` and `wasm-ld`.
