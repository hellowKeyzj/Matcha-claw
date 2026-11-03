# lance-linalg 4.0.0

Vendored from the crates.io release (upstream commit
`ed7e83c0d20eb611147e8dd327c037c92d125b2d`), without changing its version or
public API. All Wiki targets use LanceDB 0.27.2 / Arrow 57 and this one patched
Lance 4.0.0 dependency; there is no Intel-specific legacy dependency stack.

Backported fixes:

- [Lance #5379](https://github.com/lance-format/lance/pull/5379): independent
  availability cfgs for the f16 and distance-table C kernels. Upstream reverted
  this fix when retiring Intel macOS support in #5391.
- [Lance #7121](https://github.com/lance-format/lance/pull/7121): only advertise
  compiled f16 kernels when the feature is enabled, and check AVX512BW before
  dispatching to the distance-table kernel.
- Explicit `-mavx512f -mavx512bw` target flags replace `-march=native`, matching
  the kernel's intrinsics and the current upstream build. This supports
  ARM-to-Intel cross-compilation without requiring AVX-512 on the build host.

The upstream AVX2/scalar implementations and all existing tests are unchanged.
This does not restore upstream's official Intel macOS support or alter database
formats. macOS full linking and Intel runtime validation remain required.
