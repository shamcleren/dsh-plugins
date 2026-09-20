# Native launcher

The Swift application launches the official DSH entry from the bundled npm runtime. Plugins are installed in the app's persistent DSH home, not copied into the upstream source tree. The launcher owns only its child process; an occupied port is reported without terminating another DSH installation.

`native-lifecycle.patch.yml` is a launcher-owned overlay passed through the official `--patch` option. Its small policy plugin contributes the native Host lifecycle instructions through `systemPrompt.section`. User profile files and official modules remain unchanged. See [restart and recovery behavior](../../../docs/plugin-management.md#重启与配置生效).
