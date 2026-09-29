## CLI and MCP recovery transports

The CLI and stdio MCP now use the shared command registry and return the same versioned outcome envelope for recovery-sensitive commands. Sparse amendment, workflow-close, failed/stopped lifecycle, and representative payload-family calls preserve their classified success, refusal, and usage outcomes across both transports. MCP tool schemas expose the registry's payload contracts, and the smoke probe runs against isolated file and SQLite roots without live services.

## CLI 与 MCP 恢复传输

CLI 和 stdio MCP 现共用同一命令注册表；恢复相关命令在两种传输中返回一致的版本化结果信封。稀疏 Prepare 修订、工作流关闭、失败/停止生命周期及代表性载荷族调用，在两种传输中均保留其分类后的成功、拒绝或用法结果。MCP 工具 schema 暴露注册表中的载荷契约；烟雾探针使用隔离的文件与 SQLite 根目录，不依赖在线服务。
