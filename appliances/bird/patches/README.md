# Patch queue

Add upstream-applicable patches here and list their filenames, one per line,
in `series`. `scripts/prepare-source.sh` applies them with `patch -p1`.

The build readiness gate requires the patch queue to create both:

- `sysdep/cf/anycast-wasm.h`
- `sysdep/anycast-wasm/Makefile`

Those files indicate only that the port exists; the native runtime must still
pass the end-to-end checks described in the parent README before registration.
