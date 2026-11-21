---
category: Fixed
packages: root
---

- **Collaboration admission is fail-closed at the binding boundary.** A bound checkout now verifies the
  lane `storeId` and epoch on read; an unbound replacement clone may read but cannot write; a dangling,
  unreadable, or non-regular execution store can no longer look absent.
- **Legacy collaboration rows are never hidden by execution metadata damage.** A readable unfenced store
  with collaboration rows still requires the reviewed cutover, bound or unbound; a genuinely separate
  collaboration lane remains usable.
- **Cross-domain composites bind before reserving.** The execution-side reservation is created only after
  the collaboration binding is accepted, so a refused binding leaves no intent.
- The engine, command, CLI, host, and hook suites now assert the split authority through
  `collaboration.db`; the shipped write-gate bundle is regenerated from the same source.

<!-- CN -->
- **协作准入在绑定边界失败关闭。** 已绑定检出在读取时校验 lane 的 `storeId` 与 epoch；未绑定的替换
  clone 可读但不可写；悬空、不可读或非普通文件的 execution store 不再被误判为不存在。
- **execution 元数据损坏不再掩盖 legacy 协作行。** 可读但未加 fence 且含协作行的库仍需走审查过的
  cutover，无论是否绑定；真正独立的协作 lane 仍可用。
- **跨域复合操作先绑定再预留。** 只有协作绑定通过后才创建 execution 预留，绑定被拒时不会留下 intent。
- engine、commands、CLI、host 与 hook 套件改为通过 `collaboration.db` 断言拆分后的权威；随包发布的
  write-gate bundle 已由同一源码重建。
