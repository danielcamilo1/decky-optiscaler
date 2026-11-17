# Decky OptiScaler 全面审查报告

- 日期：2026-11-14
- 审查版本：main@4feb73e7f956dfb3156e4d27e1c7b40ef147dada
- 修复分支：codex/audit/2026-11-14；PR：[zesming/decky-optiscaler #1](https://github.com/zesming/decky-optiscaler/pull/1)（仅 fork，draft，目标 main；暂不合入）
- 审查范围：第一方产品路径、全部 UI/状态流、Python 后端、ASI 集成边界、脚本和测试；上游算法不在范围。
- 手段：初始审查为四个独立维度审查者、一个独立 verifier 全条目质证；静态阅读、真实后端/React 临时探针、局部 C++ ASAN、项目基线。后续修复另经独立复核、自动化回归和一台 OLED 的 Decky/游戏启动与恢复实测，范围见修复跟踪及设备记录。
- 内部评审：一轮，33 个原始 ID 合并为 28 个行动组；32 个缺陷确认，1 个焦点风险降为观察；无驳回、无未充分质证。代码严重度按可证影响调整。

## 修复约定

本报告问题修复都提交到 `codex/audit/2026-11-14` 及其 draft PR，不另开分支。每个修复提交引用问题编号；完成后原地将条目改为“已修复”并记录提交/验证，同时勾选 PR 清单。误判或另排要保留原因，不删除条目。基线同步用 merge，不 rebase/force push。S0/S1 全部处理后才可转 ready；合入须用户确认。报告是否合入保留由用户决定。

## 结论摘要

被审版本的 0.9.4 不能满足 Phantom Blade Zero 明确的 0.9.5+ 修复要求。自动配置状态失真同时涉及乐观缓存、异步目标归属与后端失败传播。更高优先级是还原保障：INI 首次接管及普通安装失败均可导致原文件丢失。新增升级必须连同原始备份、升级前快照、精确启动项、事务失败恢复和 Remove 全生命周期一起验证。

去重后：S0 2、S1 17、S2 8、S3 1。优先处理 PD-01/CD-01 文件与 INI 恢复、UI-01/02 配置及目标一致性、TS-04 自动设置错误传播、PD-03/04 的 PBZ 版本与人工要求。

## 修复跟踪（2026-11-14）

修复提交 `96e21ff`：27 组已修复，TS-05 另排。S0/S1 均已处理。旧 live ASI 的正向运行测试不适用于 0.9.5；测试版完整禁用该通道，不将历史 ABI 源码检查冒充新版本原生验证。新运行时、游戏目录、输入及 INT8 组件的固定来源见 `defaults/runtime-manifest.json` 和 `docs/phantom-blade-zero.md`。

验证：后端自检 401 项通过，FSR4 集成 15 项通过，恢复回归 58 项通过；6 个 UI harness 均通过；TypeScript、Rollup、生成文件一致性及最终 ZIP 离线全生命周期通过。新增故障注入覆盖中断恢复、提交后清理、旧清单升级、晚接管原件、目录权限、无关文件保留、失败后重试及跨面板异步状态。独立复核发现的实施问题均已修复后再验证。

已在目标 OLED 设备原位替换同名插件；游戏模式前端正常加载，用户完成游戏体验。日志识别社区 4.1.1b、INT8 钩子和新 FFX context。实际快照回退的 38 项记录一致，Remove 后 3 个原始游戏文件（499,345,640 字节）的哈希和权限一致；游戏自带 D3D12、其他游戏设置及当前 21 个配置/存档文件保持不变。随后恢复原 FSR 4.1 实验状态，18 个受管文件（含 INI）的字节和权限及全部插件设置一致，新的回退点可用。不据此宣称画质、帧率或长期稳定性已认证。详见 [设备验证记录](../validation/steam-deck-2026-11-14.md)。

补充兼容性检查确认 PBZ 的目录/版本约束与显式 INT8/FG-off 实验只作用于对应游戏；补充提交 `509fcf7` 覆盖“重命名快捷方式显式绑定 PBZ wiki 后仍拒绝正确目录”的边界，以及缓存缺失、模糊命中及异步查询期间的身份一致性，普通游戏继续使用通用计划。按用户要求，PR 保持 draft，等待正式 0.9.5 的固定来源与回归验证后再决定合入。

当前 Live 适配补充：原生桥已按固定 pre5 核心重新实现并恢复完整 14 项能力；TS-05 已由真实 Windows/Proton 行为测试补齐。此前“整体禁用 Live”的描述仅记录 pbz.1 历史阶段，不代表 pbz.2。最终 PR 复审覆盖产品、UI、代码和测试，修复及精简结果见该 PR 最新审查评论；当前设备证据见验证记录。

## 追加复核（2026-11-15，pbz.3）

按用户补充要求，通用 Setup 已移除本地 LSFG/关闭 FG 的实验入口和说明，保留 wiki 的 PBZ 目录、版本与 100% 输出要求。Basic 的 wiki FG 建议仅在 FG 开启时展示；自动设置按实际 INI 保留任一侧显式 nofg，不依赖实验偏好。

新增打开游戏页时的受管 0.9.4 自动升级，沿用原安装事务与不可覆盖快照，保留用户配置和启动参数。独立代码与产品/UI 复核发现并关闭身份核对、中断恢复、页面卸载、运行状态竞态、显式回退保护、临时失败重试及误导文案问题；无剩余必须修正项。新增第七个 UI harness，补齐旧 manifest、异步取消与回退/Remove 回归。完整 PR 的既有原生与实机恢复证据继续复用。设备恢复连接后，pbz.3 已同名覆盖安装；实际旧游戏配置页自动升级、48 条快照记录回退、重新打开后的回退保护及恢复升级均通过。配置和启动项保留，影之刃零及其他受管游戏文件未改变。最终检查结果及设备限制见 PR 验证评论和设备记录。

## 项目画像

SteamOS/Bazzite 的 Decky 插件，用手柄完成发现游戏、匹配 wiki、部署代理、设置 FSR/可选 FG、监控、卸载恢复。React/TypeScript 前端调用 main.py RPC 与 Python service/installer/wiki/autoplan；live ASI 依赖固定 OptiScaler 内部内存布局。现行捆绑 0.9.4 与旧 schema。测试为 Python 自测、FSR4 生命周期 unittest、三个 jsdom harness；CI 有类型、生成物、构建及打包，没有覆盖率/lint 配置。没有版本内 agent 指令文件；遵循本会话用户给定的工作原则。

## 精简建议

统一启动项合并/移除的所有权规则（PD-02/07）；重施计划保留玩家选择（PD-01）；把版本、目录、游戏内要求、未解析项收回同一安装清单（PD-03/04）；自动模式文案遵照现有按需应用行为（PD-06）。新版未验证 ABI 时整体停用本插件 live 控制，避免错误地用旧 ASI 解释新内存布局。用户外置 lsfg-vk 不属于本插件管理范围。

## 问题清单

### [CD-01] 普通安装在最后才记录清单，失败会留下不能按原状态撤销的半安装
- 维度：代码 | 严重度：S0 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）（合并 TS-02）
- 位置：py_modules/optiscaler/installer.py:559-610，py_modules/optiscaler/installer.py:654-669，py_modules/optiscaler/service.py:690-698
- 现象：安装先删除旧代理、恢复旧代理位置的游戏 DLL，再移动原文件至备份并逐一复制；整个过程无回滚，直到全部文件和插件处理完成后才写 manifest。服务只在外层将异常转为失败结果。
- 依据：`place()` 中 `_stash()` 已移动原文件后直接 `shutil.copy2()`；任一次复制失败均直接离开安装函数。确定性验证建议：临时 game/payload 完成第一次托管安装，然后切换代理文件名，并在第二次 copy2 注入 OSError；旧 manifest 仍记录旧代理，旧代理位置却已经恢复成游戏原 DLL。此时按旧 manifest 卸载会把恢复的游戏 DLL 当作本插件文件删除，而这项备份已经在迁移时移回游戏目录。首次安装也会留下没有 manifest 的半安装，之后走无管理卸载的宽泛删除路径。
- 影响：磁盘不足、文件权限或单个文件复制失败时，安装报告失败却已改变游戏；代理迁移失败后继续卸载可以删除游戏原 DLL。现有 `_replace_fsr4()` 已实现的回滚保障没有覆盖更常用的普通安装。
- 修复建议：预检全部必需输入、以 staging/journal 保存实际改动和旧 manifest，替换与清单提交组成同一事务；任何失败恢复旧文件、旧代理、INI 和 manifest。对首次安装及换代理的中途失败分别验证。
- 独立验证：临时目录注入复制失败，卸载确实删除刚恢复的原游戏 DLL，升为 S0。

### [PD-01] 原有 OptiScaler.ini 没有备份，安装或卸载会丢失用户配置
- 维度：产品 | 严重度：S0 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）（合并 PD-05）
- 位置：py_modules/optiscaler/installer.py:577-593，py_modules/optiscaler/installer.py:706-713，py_modules/optiscaler/service.py:617，README.md:50-53
- 现象：普通支持文件经过 `place()` 备份，但 INI 直接复制；`preserve_ini=False` 覆盖现有文件，`True` 虽然保留文件，也把它加入此次安装的 `files`。卸载按该列表删除 INI。
- 依据：577-583 的备份逻辑没有用于 589-593 的 INI。引导安装在 service.py:617 传入 `False`，因此用户已有手动安装配置会立即被 stock 配置替换；即使调用保留模式，706-713 仍把那个原有文件当成安装产物删除。与 README 的“覆盖文件先保留、移除后恢复”承诺直接冲突。可验证序列：预放有独特内容的 INI → 分别用保留/不保留模式安装 → 卸载 → 检查原始内容。
- 影响：迁入本插件的手动 OptiScaler 设置和调优记录会不可恢复地丢失；“保留配置”选项无法保证卸载后还在。
- 修复建议：把首次接管的原始 INI 纳入同一备份/所有权流程。保留模式区分“借用已有 INI”和“插件新建 INI”，卸载只删除后者；覆盖模式先备份再写 stock，并恢复最初版本。增加上述两条生命周期验证。
- 合并 PD-05：已安装后重新自动设置覆盖整个 INI，丢失玩家选择与 INT8；重施必须保留用户配置。

### [CD-02] 增量安装和重装会丢失文件所有权，卸载遗留 OptiPatcher 等组件
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/service.py:913-931，py_modules/optiscaler/installer.py:551-555，py_modules/optiscaler/installer.py:619-648，py_modules/optiscaler/installer.py:654-666，py_modules/optiscaler/live.py:260-269
- 现象：`install_optipatcher()` 直接复制 ASI，从不把它加入 manifest。重装时虽然读取 old_files，但新清单完全取自本次 created；先前导入的支持 DLL、REFramework 或本次未选中的 OptiPatcher 文件留在磁盘，却不再出现在 files 中。`live.remove_asi()` 也只删除自己的 ASI，不删除 OptiPatcher。
- 依据：最短生产路径是普通安装不勾 OptiPatcher → 单独启用 OptiPatcher → 卸载。启用没有修改 manifest，托管卸载只删除 manifest.files 和 live 自己的文件，因此 `plugins/OptiPatcher.asi` 保留。另一条路径是 import_fsr4_files 把文件加入 files → 重装 → 新 files 不再包含导入文件。两条均可在临时目录用真实 installer/service API 核对，无需游戏。
- 影响：用户执行“移除 OptiScaler”后，第三方运行时插件或 DLL 仍留在游戏目录；重新安装另一套 ASI loader 时可能继续加载，故障排查和卸载恢复承诺失真。
- 修复建议：统一增量文件的 stash/manifest 注册入口；重装明确保留并沿用旧组件记录，或按用户选择实际移除，避免只丢记录。增量禁用也同步更新清单，并保护先前存在的同名组件。

### [CD-03] Live 通道是单个可覆盖邮箱，连续改动会被报告已发送却永远不执行
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/live.py:646-666，py_modules/optiscaler/live.py:698-707，py_modules/optiscaler/service.py:779-799，asi/live.cpp:1789-1805，src/hooks/useConfig.ts:112-119
- 现象：每次 live 改动都替换同一个 cmd 文件，只包含这次 changes；ASI 每 200ms 读一次，没有队列或以 status.seq 确认消费后再发送的步骤。后端 INI 锁在 push 前已经释放，push 可并发，且大家共用同一个 `.cmd.tmp` 名称。
- 依据：在 ASI 下一轮轮询前，先调用 apply_changes 关闭 FG，再调用 apply_changes 修改 Sharpness，第二次文件只有 Sharpness，FG 命令已不存在；两次返回均为 sent=True。即使调用严格串行也会丢失，独立面板或 immediate 的 Basic 控件增加触发机会。并发时还可出现 temp 文件被另一调用 replace 后，前一调用 os.replace 失败。前端将 sent 且无 deferred 视为 fullyLive，没有校验 ASI 的 seq/applied。
- 影响：磁盘记录和运行中的游戏分歧，UI 不提示需要重启；FG 开关或上采样器选择可能始终没有作用，直到用户重启游戏。
- 修复建议：每 target 建立序列化队列，以 ASI 确认消费为提交点；或维护完整待应用状态并合并未确认变更。使用唯一临时文件和单调序号，超时/拒绝必须反馈为未完成 live 应用。

### [CD-04] 普通重装和 ASI 修复会直接截断正在映射的 DLL
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/installer.py:297-315，py_modules/optiscaler/installer.py:577-583，py_modules/optiscaler/live.py:239-250，py_modules/optiscaler/service.py:690-698，py_modules/optiscaler/service.py:944-952，src/components/InstallPanel.tsx:405
- 现象：FSR4 替换有 require_stopped_install 的运行中检查和 atomic_copy；普通 install 使用 copy2、install_plugin_asi 使用 write_bytes，均可截断原 inode。它们没有相同的后端检查。手动安装面板的按钮只检查 busy/writable；LivePanel 的前端检查只依赖心跳 attached，在游戏已映射但 ASI failed/心跳过期时仍可提供重装。
- 依据：普通 install 和 install_live 的完整服务调用路径未调用 require_stopped_install。`live.py` 写入明确使用 `destination.write_bytes(source.read_bytes())`，不是替换临时文件。项目自己的 LivePanel.tsx 对旧 ASI 的说明也明确指出“truncating a mapped file”会使游戏崩溃。建议主验证用假 maps/status 或受控测试替换探针，确认运行中拒绝应发生在首次写文件之前；不应拿真实游戏破坏性验证。
- 影响：用户从正在玩的游戏进入设置后重装、或在连接失败时修复 ASI，可能使游戏进程崩溃并丢失未保存进度。前端防护无法覆盖直接 RPC 和心跳不可用的情况。
- 修复建议：为所有会替换/删除运行时 DLL/ASI 的后端入口共享“游戏已停止”守卫；无需托管 manifest 的检查应从 require_stopped_install 拆出。复制用同目录临时文件原子替换，并在下载后、提交前重查。

### [CD-05] 载荷缓存把一个文件存在当作解压完成，失败后的残片会被后续安装信任
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/payload.py:105-107，py_modules/optiscaler/payload.py:128-158，py_modules/optiscaler/service.py:57-63，py_modules/optiscaler/installer.py:539-541，py_modules/optiscaler/installer.py:595-606
- 现象：Payload.ready 只检查 OptiScaler.dll 存在。解压直接写正式缓存目录，失败后不清理或标记失败；只要失败前产出这个 DLL，下次 ensure_payload 会直接返回。安装只强制检查主 DLL，支持文件和目录缺失会被静默跳过。
- 依据：`ensure()` 只在当次 archiver 返回成功且 ready 时成功，但失败抛出后 root 保留；下一次 service.ensure_payload 的 ready 快路径完全跳过 archive 验证及完整性检查。确定性验证建议：模拟提取器先写主 DLL 后失败，并留下一份 INI、缺失支持 DLL；下一次 ensure 直接成功，installer 对缺失支持文件执行 continue 并报告安装成功。缺失 INI 则在已经替换主代理后失败，叠加 CD-01。
- 影响：一次解压中断/超时会污染共享缓存，随后每个游戏都可能安装不完整载荷；界面显示准备完成、安装成功，实际启动或 FSR/FG 路径缺 DLL。
- 修复建议：解压到唯一临时目录，核对所有必需文件和可信摘要后原子提交缓存；只有成功提交才创建完成标记。ready 校验完成标记及完整文件集，旧的 marker-only 缓存应迁移/重建。

### [CD-08] 若干写游戏目录的 RPC 未进入统一互斥区，会与安装/卸载相互覆盖清单
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/service.py:484-493，py_modules/optiscaler/service.py:861-894，py_modules/optiscaler/service.py:913-952，py_modules/optiscaler/installer.py:275-292，py_modules/optiscaler/installer.py:423-467
- 现象：install/uninstall/write_config/FSR build 使用 _mutation_lock，但 import_fsr4_files、安装/移除 REFramework、OptiPatcher 及 live 安装不受同一锁保护，仍然在 to_thread 中读改写同一个 manifest 或 DLL。
- 依据：示例：import_fsr4_files 读取 M0 后暂停；uninstall 在 mutation_lock 内删除 M0 的文件并恢复备份/删除 manifest；import 恢复后继续复制支持 DLL，并把最早读到的 M0 连同新 files 写回，重新出现一份指向已删除代理的“托管安装”。另一例：remove_reframework 和 import 各自读取 M0，后写者覆盖前者的 files/backups 更新。前端 busy 是局部组件状态，不能作为这些后端 RPC 的互斥保障。
- 影响：并发操作可能遗留 DLL、复活已卸载 manifest、丢失备份登记，使后续卸载/检测行为错误。FSR build 的二次检查和事务也会被锁外写入绕过。
- 修复建议：所有更改同一 target 文件/manifest 的服务操作进入同一个目标级锁；将内部 helper 与对外事务入口区分，避免嵌套死锁。下载可在锁外，实际文件/manifest 读取到提交均应在锁内；以受控线程交错验证最终清单和备份一致性。

### [CD-09] 安全类，详情见私下渠道
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 公开报告不包含具体位置或复现方式；独立质证已确认，后续修复状态在此跟踪。

### [CD-10] 安全类，详情见私下渠道
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 公开报告不包含具体位置或复现方式；独立质证已确认，后续修复状态在此跟踪。

### [PD-02] 安装时整段替换启动项，会关闭玩家已有的包装器和游戏参数
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）（合并 UI-04）
- 位置：src/components/SetupChecklist.tsx:486-488，src/components/SetupChecklist.tsx:424-430，src/components/InstallPanel.tsx:188-193，py_modules/optiscaler/autoplan.py:391-397
- 现象：引导安装默认勾选设置启动项；执行时把只含本插件 override/wiki flags 的字符串写成 Steam 的完整启动项。手动安装的写入动作也一样。之前的启动项只为未来卸载记录，并未参与当前写入。
- 依据：`run()` 记录旧值后直接 `setLaunchOptions(..., planned.launch_options)`；`applyLaunchOptions` 与手动入口也直接写入生成字符串。生成器没有输入现有启动项。以现有 `gamescope -- %command% -example` 为静态示例，安装后将只剩 DLL override 和 wiki flags，包装器及 `-example` 都消失。
- 影响：原来依赖环境变量、gamescope、其他模组/插帧包装器或特定游戏参数的启动方式在安装时改变。用户目标中的 lsfg-vk 若通过启动包装器接入，也会受到影响；保留备份只允许卸载后找回，无法保证 OptiScaler 与已有设置同时工作。
- 修复建议：解析并合并现有 `WINEDLLOVERRIDES` 与游戏 flags，保留既有 `%command%` 外层包装和参数。展示最终字符串；读不到或无法安全合并时，提供具体手动合并建议，避免默认直接替换。

### [PD-03] Phantom Blade Zero 明确要求 0.9.5+，自动计划仍允许安装 0.9.4 并宣告完成
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/constants.py:3-5，py_modules/optiscaler/autoplan.py:424-468，py_modules/optiscaler/service.py:617-628，src/components/SetupChecklist.tsx:770-785，src/components/SetupChecklist.tsx:490-493
- 现象：运行时固定为 0.9.4；匹配到 wiki 后计划即为 available，既不抽取/比较明确的最低运行时要求，也不阻止不满足要求的安装。UI 随后提示可以自动配置、已配置完成。
- 依据：官方 [Phantom Blade Zero wiki](https://github.com/optiscaler/OptiScaler/wiki/Phantom-Blade-Zero)（2026-11-14 读取，页面显示 2026-11-12 编辑）明确将 0.9.5 及以上作为必需修复版本；这不是仅依据 Last Tested Version 推断最低版本。autoplan 的 warning 仅涉及不兼容标记、REFramework 与泛化 Known Issues，缺少版本约束；实际安装始终来自固定 0.9.4 payload。FSR 4.1.1b 只替换 FidelityFX DLL，installer.py:330-385 没有升级 OptiScaler runtime。
- 影响：用户当前想在 Steam Deck 上运行 Phantom Blade Zero 的目标无法由当前插件提供的组合满足，却容易被“自动完成”与“FSR 4 已存在”误导成受支持组合。选择新 FSR DLL 不能补上游戏要求的 OptiScaler 修复。
- 修复建议：为明确的最低版本建立结构化约束，计划与执行层共同拒绝不满足要求的组合并说明需要哪个版本。升级 payload 时同时验证 schema/live ASI ABI 和该游戏路径，再解除阻断；不要仅把 Last Tested Version 一律当最低版本。

### [PD-04] 自动配置没有展示剩余人工步骤，PBZ 必需的 100% 输出比例完全没有出现在 UI
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/autoplan.py:204-215，py_modules/optiscaler/autoplan.py:220-276，py_modules/optiscaler/autoplan.py:451-468，src/components/SetupChecklist.tsx:763-942，src/components/InstallPanel.tsx:223-239，README.md:32-35
- 现象：自动计划生成 `warnings`/`unresolved`，生产 UI 没有渲染这些字段；对 prose 的处理只识别 INI 赋值等少量形式，未识别的普通句子也不会进入 unresolved。手动兼容性区域只显示列表 notes 和详情 Known Issues，不显示详情 Notes。
- 依据：全 src 搜索 `plan.warnings`、`planned.warnings`、`plan.unresolved`、`planned.unresolved` 没有结果。官方 [PBZ wiki](https://github.com/optiscaler/OptiScaler/wiki/Phantom-Blade-Zero)（2026-11-14 读取）把游戏内 Super Resolution Output Scale 必须保持 100% 写在 Notes，说明降低会破坏升频并产生伪影；这既不是 `Key=value`，也不是上述两处 UI 输出的字段。该页指定的非标准安装目录也只能在手动面板 Known Issues 中看到，引导路径不提醒。README:34-35 却承诺无法放置的要求会呈现给用户。
- 影响：完成清单并不等于满足游戏前置条件。PBZ 用户即使修正了运行时和目录，仍会漏掉必要的游戏内设置；需要人工决定的 INI 建议或明确不兼容 warning 也会被隐藏。
- 修复建议：把“已自动执行”和“仍需玩家完成/决定”的步骤同时放入同一计划与清单。至少完整呈现 Notes、Known Issues、warnings、unresolved，并将版本/目录等关键要求提升为具体检查项；存在未完成必需项时避免完成态文案。

### [PD-07] “只移除 OptiScaler override”会删除同一变量中的其他 DLL override
- 维度：产品 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）（合并 CD-06）
- 位置：src/launchOptions.ts:71-78，src/launchOptions.ts:121-149，src/components/SetupChecklist.tsx:611-613，README.md:115-118
- 现象：移除动作把任何包含本代理 stem 的整个 `WINEDLLOVERRIDES=...` 赋值删掉，而不是只删对应 clause。界面仍把它命名为只移除本插件 override。
- 依据：对合成示例 `WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command% -dx12`，71-78 的正则命中完整赋值，回调发现 `dxgi=` 后返回空串，结果只剩 `%command% -dx12`，`dinput8=n,b` 一同删除。此示例符合 autoplan.py:395 自身生成多 override 的格式；玩家还可能在安装后将其他 mod override 合并在同一变量中。launchChoices 用这一结果作为 clear choice，UI 在卸载成功后直接写它。
- 影响：选择保留其他配置的玩家会意外关闭 REFramework 或其他 mod 的 DLL 加载；“只移除”无法达到承诺，且无原始记录的外部安装没有完整还原选项。
- 修复建议：按 Wine override 的 clause/库名语法解析，只移除本插件拥有的 stem，保留其他 clause、原有参数和包装器；一个 clause 含多个库名时也应只移除归本插件的名称。补充组合变量和无原始记录的移除验证。

### [TS-01] 两个 UI harness 的行为检查失败不会使测试失败
- 维度：测试 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：testharness/run.tsx:648-672、1497-1500；testharness/all-options.tsx:35-44、71-90；.github/workflows/build.yml:65-77
- 现象：`run.tsx` 将“自动安装的三步是否存在”“关闭一步是否变成 Do both”等条件插进 `console.log`，结果为 false 时只打印 false；最后退出码仅由 React 错误数决定。`all-options.tsx` 计算未分组 section、空 enum、倒置范围，但退出码仍仅由 React 错误数决定。CI 对应入口也只查 React 0 标记。
- 依据：`run.tsx:671-672` 的行为条件没有进入任何失败计数；`1497-1500` 只消费 `errors`。`all-options.tsx:75` 增加 `badEnum`，`83-86` 找出 `badRange`，`90` 却只检查 `errors.length`。因此行为检查 false、`badEnum > 0` 或 `badRange.length > 0` 均能得到零退出码和 CI 的 React 0 标记。静态控制流已足以证明，无需称现有全部测试为“假测试”或推断基线存在失败。
- 影响：这些 harness 覆盖了安装步骤、启动参数、wiki 状态、选项可达性等核心 UI 行为，但核心条件回归时，常规测试仍可全绿；维护者看到的“pass”只证明 React 未报错。
- 修复建议：复用 `live-fields.tsx` 的 `check()` 与失败计数，把实际要求变成可失败断言，并让行为失败与 React 错误共同决定退出码。`all-options` 对缺失 section、空 enum、非法范围等明确约束加断言；有意允许的情况单独说明。CI 直接依赖 harness 退出码。修复后可在临时副本把一条明确期望替换为 false，验证两个入口均退出非零；不需要修改生产代码来证明这个根因。

### [TS-04] 自动安装的服务编排没有集成测试，成功状态未受实际配置结果约束
- 维度：测试 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：scripts/selftest.py:1953-2080、2673-2701；testharness/run.tsx:140-141、640-672；py_modules/optiscaler/service.py:601-633、635-653；src/components/SetupChecklist.tsx:449-488
- 现象：Python selftest 的自动化测试直接验证 `autoplan.build/setting_changes/framegen_changes`，没有调用 `service.auto_install()` 或 `apply_auto_settings()`；UI 则固定这两个 RPC 的成功 fixture，主要检查步骤展示和开关文案。整个“安装文件→写 wiki 配置→记录自动模式→UI 报告完成”边界未被串起来。
- 依据：测试脚本对两个服务方法无调用；UI 的 `auto_install` / `apply_auto_settings` fixture 为固定 `ok:true`。生产 `auto_install()` 在 `write_config()` 返回 `ok:false` 时仍记录目标/自动模式并返回 `ok:true`（`service.py:623-631`）；`apply_auto_settings()` 同样在写结果失败时返回成功（`649-653`）。`SetupChecklist.run()` 仅根据 RPC 的 `ok` 决定是否继续写 Steam 启动参数。因此纯 plan 测试和恒成功 RPC fixture 不能检验配置失败是否传播给用户。
- 影响：自动安装是主要用户路径，配置没应用仍被标为完成的失败状态缺少回归保护；实际落盘的文件、自动模式和 UI 的完成状态可能不一致。
- 修复建议：增加服务层离线集成测试：使用真实临时安装目录与可控 wiki recommendation，调用 `auto_install`，验证代理名、wiki INI 值、FG 成对设置、自动模式和返回结果；对无 plan、install 失败、`write_config ok:false`、部分 rejected、抛异常分别断言不会返回完整成功。UI 侧点击实际执行按钮，记录 RPC 参数和 Steam setter 调用，并验证失败时不继续宣称全步骤完成；前置 TS-01 的可失败断言修复。
- 独立验证：实际 service.auto_install/apply_auto_settings 在 write_config 返回失败时仍 ok:true/auto:true，作为生产缺陷保留。

### [UI-01] 自动设置写入成功后，旧的本地写入记录仍覆盖新配置
- 维度：界面与交互 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）（合并 TS-03）
- 位置：src/components/GameDetail.tsx:184-191，src/hooks/useConfig.ts:52-63、78-82、144-153，src/config/writeRecord.ts:22、75-88
- 现象：手动修改过选项后启用 Automatic，后端 INI 已更新，设置控件仍可显示之前的手动值；屏幕同时提示 Automatic settings applied。
- 依据：每次手动修改都立即 `rememberWrites`，成功写入后并不清除此记录。`changeAuto` 在 `applyAutoSettings` 成功后只 `config.reload()`；reload 用 `overlayWrites` 把最近 60 秒内的手动值盖回后端返回值，再盖上 pending/inFlight。对照同文件重置路径 323-327 已先 `forgetLocal()`，自动应用漏掉了这个失效步骤。复现：选一个 wiki 会设置 FG 方法或兼容性参数的游戏，关闭自动，手动改成与 plan 不同的值并等写入完成，60 秒内开启自动，再看该选项及 INI；例如 wiki `FGInput/FGOutput=fsrfg/fsrfg`，先手动选 XeFG，开启自动后后端回到 FSR FG，UI 仍可能显示 XeFG。即使过了 60 秒，当前 values 也不会自己刷新，必须再次触发读取。
- 影响：用户不能判断自动配置究竟是否生效；再次操作会把屏幕上的旧状态重新写回。与用户描述的“实际生效但界面未同步”一致，但不宣称它解释了全部案例。
- 修复建议：把自动应用作为明确的配置事务：等待/协调已发出的编辑，失效被该事务取代的本地记录和队列，再使用本次权威返回值或重新读取。不要只清全局 record 而留下 pending/inFlight；补一个“手动改值 → 自动应用 → 原位同步”的场景。
- 合并 TS-03：写 RPC 返回 ok:false/抛异常时也未撤销全局乐观记录；独立 React 探针复现未落盘的值在重新进入后仍显示。修复要同时覆盖失败回退、在途写入和自动配置替换。

### [UI-02] 切换游戏时沿用上一个游戏的详情和可写控件，可能写错目标
- 维度：界面与交互 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/ManagerPage.tsx:46-64、170-178，src/components/GameDetail.tsx:136-162、184-188、212，src/components/NowPlaying.tsx:30-52、76、104、131-141，src/components/QuickPanel.tsx:91-124、196-225
- 现象：已经展示游戏 A 时，打开 B/运行游戏变为 B，B 的名称、appid 或 wiki 请求可与 A 的 install path、选项控件共存。新请求失败时旧详情仍会保留。
- 依据：ManagerPage 通过订阅接收新 target 并直接改 selection，渲染 GameDetail 没有游戏 key。GameDetail.load 只设 loading、不清 detail，且只在 `loading && !detail` 隐藏页面；其 `gamePath/appid` 已为 B，但 `targetDir` 仍从 A 的 detail 获取。此时 `changeAuto` 可调用 `applyAutoSettings(A安装目录, B路径, B名称)`。NowPlaying/QuickPanel 同样在开始 resolve 新游戏时保留旧 detail，后者甚至在 resolving 时照常渲染 installed 控件。所有 resolve/load 都没有请求代次/目标校验，较旧响应还可覆盖新响应。复现：A 详情打开时，经 QAM 选择 B 并延迟 B 的 get_game；期间切自动/改参数，检查 RPC 目标。或保持 Now Playing 挂载，A→B，延迟 B resolve，观察标题 B 和写入 A 的控制器。
- 影响：不只是显示滞后，用户会在以为修改 B 时修改 A，或把 B 的兼容配置写进 A；连续打开目标也可能最后停在旧游戏。
- 修复建议：按游戏身份隔离详情和所有可写状态（可用 key 或目标绑定的 state），新目标未确认前禁用旧控件；为 resolve/getGame/useConfig/useAutoPlan 的异步结果加请求代次或目标校验。一个可复现的延迟请求场景应同时验证展示和 RPC 目标。

### [UI-03] 自动开关没有进行中状态，快速关闭后后台仍会重新开启
- 维度：界面与交互 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/GameDetail.tsx:184-195、378-389，src/components/BasicPanel.tsx:229-230、451-467，src/components/SetupChecklist.tsx:1105-1121，src/hooks/useAutoPlan.ts:171-176，py_modules/optiscaler/service.py:648-653
- 现象：启用 Automatic 后，在 wiki 设置应用尚未完成时关闭它，界面停在关，持久化状态却可能为开；重进页面后开关又打开。
- 依据：`setAuto` 立即设本地布尔值后写 pref；GameDetail 随后再异步 `applyAutoSettings`，没有 applying 锁或代次。该后端应用在写完后无条件 `set_auto_mode(game_path, True)`。BasicPanel 的 busy 只来自 disabled/FSR 安装，SetupChecklist 的 busy 也不覆盖外部 onSetAuto。复现：延迟 apply_auto_settings，开自动→等待请求发出→关自动并等待 set_auto_mode(false) 完成→释放 apply；UI auto=false，但后端最后 pref=true。
- 影响：界面错误描述谁拥有设置；用户明确关闭后的下一次读取又重新打开，容易产生反复切换和覆盖手动设置。
- 修复建议：让自动模式变更与应用成为单个可等待事务，操作期间禁用同一开关并显示 Applying；或以请求代次/期望最终状态处理反向操作，后端不要由一个已过期应用请求擅自改回 mode。失败时回滚并显示原因。

### [UI-07] 全屏 Now Playing 丢掉写入错误与需要重启的反馈
- 维度：界面与交互 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/NowPlaying.tsx:50-56、126-160，src/hooks/useConfig.ts:105-133，对照 src/components/QuickPanel.tsx:202-208、229-250
- 现象：同样的 Basic 控件在 QAM 会报告写入失败/需要重启，全屏 Now Playing 上却只显示乐观更新后的控件，没有失败或延迟生效状态。
- 依据：NowPlaying 取 useConfig 后只使用 values/loading/setOptions 等，不渲染 error、dirty、live 结果。RPC `{ok:false,error:...}` 及 throw 只由 useConfig 存为 error；局部 BasicPanel 不知道写入结果。后端未 attached 时普通 FG toggle 会得到 `live.sent=false` 并置 dirty，该页面也不显示。复现：全屏 Now Playing 对未连接 live 的运行游戏切 FG，或 mock write_config 失败；UI 选中值改变但没有保存失败/重启说明。对照 QAM 上同路径有 Notice 和 Restart game to apply。
- 影响：用户以为运行中切换成功，实际上可能没有保存，或只有下次启动才生效；核心“无需游戏内 overlay”路径缺少结果判断。
- 修复建议：复用详情/QAM 的写入错误、保存状态与重启提示组件，让所有 BasicPanel 宿主一致呈现 hook 的结果；失败时回滚/重读应与 hook 层修复协调。

### [CD-07] IPv4 重试修改进程全局解析函数，两个下载重叠可永久泄漏补丁
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：py_modules/optiscaler/wiki.py:150-160，py_modules/optiscaler/wiki.py:198-209，py_modules/optiscaler/service.py:65-117
- 现象：每个 _ipv4_only 实例保存当时的 socket.getaddrinfo，再全局替换，离开时无条件还原；网络工作在多条 to_thread 线程运行。服务的 single-flight 仅按 wiki key，list/page/FSR 下载可并行。
- 依据：线程 A 进入保存 original 并装 A；线程 B 进入保存 A 并装 B；A 先退出恢复 original；B 后退出恢复 A。最终 getaddrinfo 永久停留在 A 的 IPv4 包装器，而非 original。该序列不依赖真实网络即可用两个上下文按此顺序核对身份；本审查未执行探针。
- 影响：一次同时发生的网络超时会改变该 Python 插件进程后续所有 DNS 请求，IPv6-only 地址从此无法解析，且越过当前请求的作用域；重复发生还会累积包装链。
- 修复建议：在请求局部连接实现中选择 AF_INET，不改 socket 全局函数；如果暂时只能串行化，应覆盖使用此解析函数的全部下载连接创建过程并保证恢复原函数，避免仅给单个 with 块加不完整锁。

### [PD-06] 自动模式承诺持续跟随 wiki，但刷新只更新计划，没有更新已安装配置
- 维度：产品 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/SetupChecklist.tsx:893-895，src/components/SetupChecklist.tsx:1113-1116，src/hooks/useAutoPlan.ts:92-104，src/hooks/useAutoPlan.ts:150-160，src/components/GameDetail.tsx:184-194，py_modules/optiscaler/service.py:635-653
- 现象：启用自动模式时确实应用一次设置；之后 wiki 后台刷新引发的 reload 只保存新 plan/recommendation/auto 状态，没有调用写配置。应用级“Refresh from wiki”也仅更新 wiki 数据。
- 依据：所有生产 `applyAutoSettings` 调用只有 GameDetail 的 changeAuto（184-194），另外 auto_install 在用户安装/重施时写一次。useAutoPlan 在 revision 变化时只重新 getAutoPlan；get_auto_plan 仅构建计划。UI 则说保持该开关可让后续 wiki 变化抵达此游戏，并给出“kept up to date”的状态。
- 影响：游戏仍使用旧 wiki 设置，新计划可能已经显示为最新、Advanced 继续锁住 wiki 管理的键，玩家没有得到“计划已变更但尚未应用”的反馈。修复崩溃所需的新规则不能按承诺自动生效。
- 修复建议：建议先把模式定义为“采用此版本 wiki 设置”，保存 applied revision，在新版本出现时提示并预览差异后应用；若产品确实要自动写入，需要在安全时点处理变更和重启提示。待问用户：是持续自动维护，还是按需应用？候选为两者；推荐按需应用并展示版本差异，避免静默改游戏配置。
- 本轮处置：按需应用的现有行为保留，将界面持续自动维护承诺改为准确的“安装/开启时应用，需要时重新应用”，不引入静默配置写入。

### [TS-05] ASI 的 ABI 检查主要匹配源码文本，缺少实际编译与内存写行为验证
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已修复（edf984a；匹配 pre5 ABI、可运行 Windows 原生测试及 CI）
- 位置：scripts/selftest.py:906-958、1658-1688、1752-1771、1872-1894；asi/msvc_abi.h:24-60、79-100；asi/live.cpp:1070-1100；.github/workflows/build.yml:44-63
- 现象：ASI selftest 确实校验了 vendored 成员顺序、关键声明、版本 pin 和源码中的 `static_assert` 字符串；但没有编译这些断言，也没有执行 `CustomOptional.assign`、`msvc_string.assign_in_place` 或 `SetField`。已提交二进制只检查 MZ、若干导出/导入字符串。配置镜像重新生成检查也不能执行 C++ 编译期断言。
- 依据：`selftest.py:1752-1761、1872-1885` 明确以 `static_assert(...` 子串存在作为通过条件；常规测试入口是生成脚本、Python 测试和前端构建，没有调用 `asi/build.sh`。`SetField` 直接把计算偏移处强转为 MSVC ABI mirror 并写入（`live.cpp:1074-1095`），字符串容量拒绝、可选值 engaged/isVolatile 的修改需要运行行为才能保护。`msvc_abi.h` 的具体赋值实现没有任何测试引用。
- 影响：成员类型大小或赋值语义变更可以保留所有被匹配的源码片段，仍通过当前测试；下一次重建 ASI 时才暴露编译布局失败，或把错误状态写进游戏进程。这里没有断言当前 ABI 已错误，也不把本机缺 Zig 当作仓库缺陷。
- 修复建议：补一个可重复的 x64 Windows 目标编译检查来实际求值布局断言，并给可独立于 WinAPI 的 ABI helper 建小型 C++ fixture：内联/堆字符串容量边界与 NUL、拒绝后字节不变、optional 的值/engaged/isVolatile、前后哨兵不被改动。较重的真实 OptiScaler/Proton attach 留给设备验证。候选变异只需一处：临时副本把 `msvc_optional<T>` 中 `value` 和 `engaged` 的顺序对调；新的布局/写入 fixture 应失败，当前文本检查可能仍通过，由主 agent 决定是否执行。

### [UI-05] 手动重选 wiki 条目后，返回引导页仍展示旧计划
- 维度：界面与交互 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/InstallPanel.tsx:112-116、269-274，src/components/GameDetail.tsx:164-172、304-311、337-346
- 现象：Manual setup 搜索并选中新的兼容条目成功后，手动页更新，返回 Setup 和 Settings 后仍使用之前的匹配名称、步骤和推荐说明。
- 依据：父子各有独立 useAutoPlan。onPick 更新后端 pin，调用 onChanged 只刷新父 detail+config，再调用子组件 lookup；父 hook 的 gamePath/gameName/enabled 都没变，未调用父 reloadPlan。复现：打开已匹配条目 A 的游戏，Manual setup → 搜索选择条目 B → Back to setup；父 SetupChecklist 仍收到 A 的 plan。若继续 Do all/reapply，后端又按持久化 pin B 生成计划，执行的内容和屏幕 A 说明不一致。
- 影响：用户无法确认选项是否保存，且自动安装预览不再反映实际将执行的步骤和文件名。
- 修复建议：由 GameDetail 统一拥有 plan/recommendation，让选择条目后显式失效并重载；至少为 Manual 的 onChanged 增加父 reloadPlan，保证同一页面所有计划消费者一起更新。

### [UI-06] 停止游戏时添加 live control 后状态不会刷新，失败结果也未展示
- 维度：界面与交互 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/LivePanel.tsx:186-201，src/components/GameDetail.tsx:163、337-346，src/hooks/useLiveStatus.ts:17-35，py_modules/optiscaler/service.py:944-953
- 现象：按提示关闭游戏后点击 Add/Reinstall live control，成功安装后仍显示 Not installed/旧版本和原按钮；服务返回 ok=false 时也没有错误反馈。
- 依据：LivePanel 丢弃 installLive 的 ActionResult，只 onChanged；父 onChanged 重读 detail/config，不调用 live hook refresh。游戏未运行时 hook 只在 targetDir/active 变化时读取一次，同路径重装不触发任何新读取。复现：未安装 live 的已安装游戏，不运行游戏，进入 Manual → Add live control，后端成功后仍保留旧 status；离开游戏详情再进入才重新读到。模拟 install_live 返回 `{ok:false,error:...}` 时界面同样没有提示。
- 影响：核心修复入口看起来无效，用户无法区分失败与未刷新，可能反复安装。
- 修复建议：检查返回 ok 并展示失败；安装成功后显式刷新 live 状态（由拥有 hook 的父组件传 refresh/统一刷新动作），显示安装后需启动游戏的状态。

### [UI-08] 启动选项的乐观状态立即被旧磁盘回读覆盖
- 维度：界面与交互 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/SetupChecklist.tsx:359-369、430-436，src/launchOptions.ts:195-203，src/hooks/useRunningGame.ts:108-136
- 现象：在缺少 Steam 实时 getter 的客户端，点击启动选项开关已经写入 Steam，开关仍可能弹回原状态且不再自动纠正。
- 依据：applyLaunchOptions 刚 `setLaunchNow(value)` 后立即 `void refreshLaunch()`；currentLaunchOptions 先读 client，读不到则从后端 Steam 配置文件回退。代码自己的 431-433 注释明确 Steam 不是同步刷盘，因此该即时回读可能必然落在旧文件上。refreshLaunch 的 effect 只依赖 appid，不会持续等待新值。复现：client 两种 getter 均不可用，backend get_launch_options 暂返回旧空串，SetAppLaunchOptions 成功；按开关后 setLaunchNow 新值立即被旧串覆盖，之后即使 Steam 落盘也没有新读取。
- 影响：实际成功被显示为失败，用户反复切换同一启动项，正好触发本项目试图避免的“开关不刷新”。
- 修复建议：写后维持按 appid 记录的期望值与操作代次，不让过期回读覆盖；若需要确认，做有限重试直到读到目标值或明确超时，超时单独说明不能确认。

### [UI-09] 全屏 Now Playing 未传已检测到的 FidelityFX 文件版本，FSR 版本名称错误
- 维度：界面与交互 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/NowPlaying.tsx:100、116-120、131-141，src/components/BasicPanel.tsx:104-117、316-317，src/config/labels.ts:53，对照 src/components/QuickPanel.tsx:213-218
- 现象：live 尚未连接或旧 live 模块没有提供 FSR 列表时，同一全屏页面上方可显示 FidelityFX 4.1.1，下面 FSR version 第 0 项却显示 FSR 4.0.2；QAM/Settings 的标签可能与其不同。
- 依据：NowPlaying 已读取 `detail.install.fsr4.ffx` 并用于页头，却漏传 BasicPanel 的 ffx prop；BasicPanel 缺少 newest 参数时会回退 schema 的第 0 项 FSR 4.0.2，而另两宿主明确传 ffx 以修正该名称。复现：detail ffx.version=4.1.1.2740，配置 fsr31/UpscalerIndex=0，live=null 或不带 ffx_upscaler_versions，比较 Now Playing 与 Settings/QAM。
- 影响：用户不能判断安装和选择的 FSR 版本是否一致，可能误以为新 DLL 未生效并重复安装。
- 修复建议：NowPlaying 传 `ffx={ffx}`，保持三宿主相同的版本来源，并覆盖“无 live 版本列表”的回退场景。

### [UI-10] Logs 的 RPC 失败会留下永久读取状态或锁死所有操作
- 维度：界面与交互 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已修复（96e21ff）
- 位置：src/components/MonitorTab.tsx:31-55、72-77、176-182
- 现象：非运行中的游戏首次读日志失败后，页面永久显示 Reading OptiScaler log；切换日志/清空日志的请求抛出后，控件一直 disabled，没有重试或原因。
- 依据：refresh 吞异常，初始 report=null 永不改变；非 live 时没有下一轮 tick。setLogging/clearLog 的 handler 在 await 前 setBusy(true)，在 await 后才 false，没有 finally，reject 时无法释放 busy。复现：停止游戏 → Logs → get_monitor reject；或先成功读到 report，再令 set_logging/clear_log reject，观察禁用状态。
- 影响：用于排障的页面在最需要错误信息时给不出结果，恢复只能退出再进；用户不知道是读取失败还是仍在等待。
- 修复建议：区分 loading/error/empty 状态并提供 retry；所有操作用 try/catch/finally 恢复 busy，检查 ActionResult.ok 并展示错误。

### [UI-11] 详情页重启入口使用裸 button，偏离项目控制器焦点组件
- 维度：界面与交互 | 严重度：S3 | 工作量：S | 置信度：中 | 状态：已修复（96e21ff）
- 位置：src/components/GameDetail.tsx:268-292，对照 src/components/DetailHeader.tsx:35-39、src/components/QuickPanel.tsx:229-247
- 现象：详情页 Saved 提示中的 Restart now 没有 Decky 焦点组件，存在仅靠 Steam Deck D-pad 无法聚焦/激活的入口。
- 依据：该按钮是唯一的裸 `<button>` 操作入口，未放入 Focusable 或注册 gamepad focus。项目已在 DetailHeader 注释中明确因为裸 button 无法被 D-pad 到达而改用 DialogButton；QAM 的同类重启动作用 ButtonItem。复现建议：在真实 Decky 环境运行游戏，改一个需要重启的选项，仅用 D-pad 导航顶部提示并激活 Restart now，比较 QAM Restart game to apply。本项静态证据充分显示实现不符合项目现有焦点方案，但实机行为尚未验证。
- 影响：主要使用控制器的用户无法使用页面提供的直接重启，需要改用 Steam 菜单/触屏。
- 修复建议：换为 DialogButton/ButtonItem 并沿用现有 gamepad 焦点布局；由主 agent 做真实 Decky 焦点验证，若实际 Steam 焦点层能注册该原生按钮则可驳回本项。
- 质证：降为 S3，静态实现风险成立；未实机证明不可聚焦。

## 审查范围、局限与下一步

已覆盖发现/安装/自动计划/Basic与Advanced/FSR4/直播状态/日志/移除及失败路径，完整静态遍历第一方模块。UI 仅 jsdom 与静态证据，尚无 Steam Deck 实机布局、手柄焦点或 Steam API 实际时序证据；不能据此认证 PBZ/FSR4.1/INT8 已能启动或性能改善。社区反馈只能指导实验，官方 Wiki 的测试平台是 Win11/RX9070XT。真实验收仍须目标设备。

用户新增的硬性验收：所有本次调整必须可回退。新装 Remove 恢复最初原文件与启动项；旧版升级另建不可覆盖的升级前快照，显式回退恢复旧运行时/INI/组件/相关设置/当时启动项。历史上已被旧版覆盖且无备份的原文件无法凭空重建，必须明确区分。新快照和兼容资源也必须随 Remove 清理。

产品取舍：本轮保留按需自动应用而纠正文案；不增加后台静默改游戏配置。UI-11 与 TS-05 为可独立后续验证项；新版不分发/使用旧 ASI，不能用原布局文本检查声称支持新 ABI。

安全条目细节仅保留本地私下渠道，不进入公开报告；报告及代码修改仍须按 skill 在推送到公开 fork 前确认。无真实账号数据、凭据或设备日志入库。

## 附录：基线及证据

Python 自测 460 passed/0 failed；FSR4 生命周期 14 passed；三 UI harness 的 React errors 均为0，live harness退出0；直接运行锁定 tsc 与 rollup 通过，schema/layout 重生成无差异；基线 zip 29文件、55.4MB。未配置覆盖率/lint，不虚构覆盖率。

安装环境本机 pnpm11，CI pnpm10；pnpm11忽略 esbuild 安装脚本返回错误，但锁定依赖和平台可执行文件均已下载，直接运行这些可执行文件验证通过。pnpm11产生的临时 workspace 配置已清理。整个流程未改 git config。

独立临时探针验证 INI 删除、代理切换失败后原 DLL 丢失、增量组件遗留、live 覆盖、解压残片 ready、并发 manifest 复活、配置失败虚值与自动应用旧值覆盖、自动写失败假成功。所有探针只操作合成临时目录并已清理；安全探针不公开。

热点：CHANGELOG 21、selftest 18、package 18、UI run harness 16、types/service/README 各13次（近六个月）。原始问题、逐条质证、过程证据保留于 git 忽略的审查工作目录；报告中的位置均指审查基线，不是修复后行号。
