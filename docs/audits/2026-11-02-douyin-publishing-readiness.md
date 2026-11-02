# 抖音官方发布能力与资格核查（2026-11-02）

## 范围与结论

对应 [GitHub #58](https://github.com/destinyTaoTao/maneki-pet/issues/58)。本报告是公开资料快照，不替代 [architecture.md §10.2](../architecture.md#102-平台对接器gateway-层新-adapter-类型) 与 ADR-0004，也不代表应用或账号验收。核查日期为 **2026-11-02**；只读取官方文档和官方团队公告，未登录真实账号、申请权限、获取凭证、上传素材、发作品或购买服务。现行 API 路径带 `v1`；多数页面没有展示文档修订版本，因此不能把访问日期当成平台版本或生效日期。

**结论：公开上传/创建接口存在，但 Maneki 实际发布仍应关闭。** 应用资格、权限获批、目标用户有效授权、真实提交、后续状态核查分别需要证据。尤其是审核/可见状态字段已有官方下线公告，旧示例不能证明当前仍可查询；未知提交也没有已核实的自动对账闭环。

## 公开证据

### 1. 主体资格要区分开发者、应用类型和发布账号

官方[开发者入驻 FAQ](https://partner.open-douyin.com/docs/resource/zh-CN/developer/join/issues) Q2/Q3 当前列出个人、企业两类身份：个人可创建小程序、小游戏、小玩法；企业身份列出小程序、移动应用、网站应用，也包含个体工商户等组织。由此只能判断：不能用“个人可入驻”推导个人可创建本案移动/网站应用；Maneki 使用哪种主体、应用形态是否被接受仍待控制台或官方确认。

[入驻类型表](https://developer.open-douyin.com/docs/resource/zh-CN/developer/join/join-into-developer-platform)也区分个人与组织的应用范围。[旧平台入驻页](https://open.douyin.com/platform/resource/docs/accession-guide/platform-accession)还写着未开放个人入驻，不能拿这一旧结论覆盖现行分类型说明。不同入口存在历史差异；后续应保留适用于目标应用的当次申请证据。

创建文档对企业资质的要求明确写在**小程序/POI 锚点挂载**上，不能据此宣称普通账号的无锚点发布一律要求企业号。反过来，无锚点也不自动获得发布资格。[创建视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)

### 2. 应用权限和用户 OAuth 是两道条件

官方上传/创建页均列 `video.create.bind`，申请路径为控制台 → 应用详情 → 能力管理 → 能力实验室 → 代替用户发布内容到抖音；均要求用户授权。[上传视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video)

[能力概览](https://partner.open-douyin.com/docs/resource/zh-CN/dop/ability/common-solution)说明在具体移动/网站应用中申请功能并填写使用场景，具体准入条件看对应能力。公开路径只证明文档列有申请入口，**不能证明本应用当前可申请、会获批、已有额度或仍保有权限**；本轮没有控制台证据，也不依据第三方“接口已全面收回/已重新开放”的说法下结论。

[抖音获取授权码](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/douyin-get-permission-code)规定先申请 scope，再通过浏览器授权页取得 code；回调必须是应用配置对应的 HTTPS 地址，不支持自定义 query。对本地桌面应用，不能直接假定 `http://127.0.0.1` 回调可用，回调承载方式是后续设计待决项。

[获取 access_token](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token)使用 `POST /oauth/access_token/`，提交表单而非 JSON，含应用密钥与授权码；响应含 `open_id`、实际 `scope` 和到期信息。code 只可使用一次、有效期 10 分钟。未来应核对实际授权 scope 与目标身份，不凭“曾登录”认定有发布权。

[登录与授权](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/sdk/mobile-app/permission/overall-permission)还说明撤销授权会立即使原 access_token 失效；应用级 client_token 与用户 access_token 的用途不同。OAuth 并不替代仓库要求的每次作品确认。

### 3. 上传标识、作品回执和审核不是同一件事

| 环节 | 当前公开契约 | 可证明的边界 |
|---|---|---|
| 上传 | `POST https://open.douyin.com/api/douyin/v1/video/upload_video/`；响应 `data.video.video_id` | 上传文件的加密标识，尚不是作品发布回执；来源见上文上传页 |
| 创建 | `POST https://open.douyin.com/api/douyin/v1/video/create_video/`；以用户 `open_id`、access-token 和上传标识提交 | 响应示例同时有加密作品 `item_id` 与作品 `video_id`；须与上传标识分开保存 |
| 可见范围 | 请求 `private_status`：0 全部人、1 自见、2 好友 | 这是提交意图，不是最终可见状态证据 |
| 后续审核 | 创建后仍有审核，期间仅自己可见 | 成功回执不能显示为“审核通过/公开可见” |

创建行及其后两行依据同一份[创建视频文档](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)。其错误码表存在 HTTP 200 搭配业务错误的情况，未来不能只检查 HTTP 成功。不要混用旧 `/video/create/`、旧 `video.create` 与本次 `v1`/`video.create.bind` 契约；旧文档也不能冒充实际调用验证。

### 4. 审核/可见查询存在证据缺口

官方团队于 **2024-11-15** 发布[移动/网站应用部分数据权限字段调整公告](https://developer.open-douyin.com/forum/bulletin/post/6736c38048f043667b75f70a)，规定 **2024-12-13 起**：`video.data.bind/video.list.bind` 停止返回 `is_reviewed`、`video_status`；`posting.behavior` 停止返回 `video_status`。这直接阻断“沿用历史字段自动判定审核/公开”的假设。

当前[查询视频基础信息](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/posting-task/video-basic-info)列出 `POST /api/douyin/v1/video/video_basic_info/`、独立 scope `posting.behavior`、权限申请和用户授权，只能查询该 token 用户的作品；但响应示例仍有 `video_status`。这是页面示例与公告的冲突，不是字段恢复的证据。未取得适用应用的最新确认与真实返回前，不能把它当成可用审核查询接口。

名为[查询视频发布结果](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/search-video/video-share-result)的页面实际介绍分享 SDK：先生成 `share_id`，传给 SDK，再接收成功回调；scope 为 `aweme.forward`，share_id 有效一小时。文档没有证明该流程能关联本案直接 `create_video` 调用，也没有提供其审核完成/最终可见状态的保证，不能挪作通用创建回执或未知提交对账接口。页面基本信息写 POST，示例却写 GET，这一差异也需联调前确认。

因此本轮未确认一条对 Maneki 适用、权限可获批、覆盖直接创建后审核与最终可见状态的公开查询链路。此为**未核实**，不是断言平台绝无此能力；后续需官方澄清或适用账号的授权验证。人工打开链接也只能作为记录在案的人工观察，不能伪称 API 状态验收。

## 账号证据与诊断呈现

以下是本轮应呈现的离线结论，不是在线权限探测结果：

| 检查项 | 状态 | 仍缺的证据 |
|---|---|---|
| 官方上传/创建资料 | 可用（仅资料） | 实际调用能力另验 |
| 个人主体的移动/网站应用范围 | 受限（按公开应用类型表） | 如走其他形态，须单独证明适用性 |
| 小程序/POI 企业关联锚点 | 受限（专项能力） | 目标账号与锚点资格；不泛化到无锚点发布 |
| Maneki 主体、应用与发布权限 | 未知 | 目标应用及当次 `video.create.bind` 获批/额度证据 |
| 目标用户身份、scope、令牌有效性 | 未知 | 独立授权验证；本轮不收集凭证 |
| 审核/最终可见状态 | 未知/资料受限 | 解决字段下线冲突并取得适用查询证据 |
| 未知提交的自动对账 | 未知 | 可查询的关联标识、幂等语义和故障验证 |
| 真实发布 | 关闭、未验证 | 前述条件明确后，另拆票、另行授权受控试发 |

诊断输出应明确资料日期、没有在线检查、发布关闭、缺少条件和人工路径；用户手填“已获批”不能把状态升级成可执行。继续允许本地备料/导出，由用户在官方入口手动发布，不要求先配置 OAuth 或支付服务。本报告不把离线诊断测试当作真实账号验收。

## 未知提交与后续契约边界

以下为依据仓库不变量提出的实施约束，不是声称抖音已提供对应 API：

1. 每次确认绑定最终视频内容摘要、文案、封面、目标应用/账号、可见范围和全部锚点参数；修改任一项重新确认。只存脱敏证据和凭证引用，不把 token/secret 放进报告或日志。
2. 创建前持久化本地操作标识与确认依据；收到回执后原样保存上传标识、作品 item_id、作品 video_id、业务码与平台追踪信息，区分提交、受理、审核、可见性。
3. 请求发出后超时、连接中断、回执解析失败或进程崩溃，可能已产生作品，应进入“提交结果未知”。本次阅读的创建契约没有给出可据以认定重复安全的客户端幂等键，也未确认按本地操作标识找回回执的接口。**不自动重发、不换 ID 重试、不因查无结果或等待超时就判定失败。**
4. 有作品 ID 时，只有已获批且已验证的查询能推进状态；字段缺失保持未知。有回执不等于公开，无回执不等于未发布。无作品 ID 时，先提供平台追踪信息和提交时间供官方/用户人工核对；相似标题和时间只能找候选，不能证明同一作品。人工对账无法确认则维持未知，不冒充精确一次保证。

建议实施切片：先完成本票离线诊断；随后单独核实目标主体/应用及权限资格；再设计并评审 OAuth 回调、密钥保存和撤销；官方明确状态及对账语义后先补版本化发布契约；最后另票授权受控试发和断网/崩溃回执丢失验证。资格与协议证据未明前，不实现实际提交，也不以自动点击网页或私有协议代替官方开放能力。

## 验证边界

- 已通过 `gh issue view 58 --repo destinyTaoTao/maneki-pet` 核对任务范围；逐页读取上述官方公开来源，并交叉检查当前接口与官方字段下线公告。
- 已实现 `node packages/cli/dist/main.js platform douyin-check` 离线 JSON 入口，输出资料日期、未知项、发布关闭及人工路径；拒绝额外参数与凭证配置。独立 CLI 进程验证正常报告与拒绝凭证参数两条路径，CLI 构建/类型检查通过；这不构成在线权限或真实发布验收。
- 未验证任何账号、权限、OAuth 回调、上传、创建、查询、Webhooks、额度或删除行为；未在 Windows/macOS/Linux 做发布运行验收。
