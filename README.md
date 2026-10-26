# ofm-credits

在 DeepSeek Harness 的会话标题栏显示当前模型所属 **Our Free Model（OFM）** 渠道的积分，带一个刷新按钮。

> **前置依赖**：需要先安装 [`dsh-our-free-model`](https://www.npmjs.com/package/dsh-our-free-model)（提供渠道账号与积分接口）。没有它时插件不会报错，只是始终显示「积分 —」。

## 适配版本

| 组件 | 版本 |
|---|---|
| `dsh-our-free-model` | **2.5.7**（已实测；2.5.x 系列同为同一套接口） |
| DeepSeek Harness | **0.2.1-rc.3**（已实测；需 0.2.1 及以上，用到了 `conversation.session.header.actions` 槽位） |

这是开发时实际跑通的组合。OFM 的接口不是公开 API，所以它的**大版本变化**（尤其是 `accountPool` 或 `credits.balances` 改名）可能导致读不到值；届时会回退到内置渠道表并在日志里记 `channel discovery failed`，不会崩溃。

## 安装

```sh
dsh plugin --profile web add github:zhishi-2233/ofm-credits
```

桌面端请在应用内的插件页安装（桌面 profile 由应用自己的插件管理器持有）。

装完**硬刷新浏览器**（Ctrl/Cmd+Shift+R）即可。

## 它长什么样

标题栏会话名右侧：

```
测试   TRAE 积分 1546 ⟳
```

- 渠道名用 `dsh-our-free-model` 的显示名（TRAE、CodeArts、MiniMax…）
- 数字是品牌蓝，标签与图标跟随主题文字色
- 货币类渠道显示币种，例如 Cline 的余额显示为 `$5`
- 点 `⟳` 立即重读，图标转动并短暂变蓝

## 行为

| 场景 | 显示 |
|---|---|
| 模型属于某渠道且有账号 | `TRAE 积分 1546` |
| 渠道存在但没有账号 | `Loomy 积分 —（Loomy 无账号）` |
| 模型不属于任何 OFM 渠道（如官方 DeepSeek 账号模型） | `积分 —（当前模型不属于 Our Free Model 渠道）` |
| USD 计费渠道 | `Cline 余额 $5` |

积分栏每 30 秒自动刷新一次；点按钮则强制立即重读。

## 它是怎么找到渠道的

两个来源，动态优先：

1. **动态**：从 `dsh-our-free-model` 的账户池读出**实际已登录**的渠道。所以你在 OFM 里新加一个账号，点一下刷新就能生效，无需改代码、无需重启。
2. **静态兜底**：账户池不可用时，回退到内置的 14 个渠道名表。

不会去猜：聚合车道上的模型 id 里出现 `glm` 这种厂商词，**不会被误判**成 ZCode 渠道——只认渠道自己的标识。

## 多会话

同时开多个会话、各用不同模型时，积分栏按**你正在看的那个窗口**解析，不会显示另一个窗口的渠道。

## 兼容性

- DSH `0.2.1` 及以上（使用 `conversation.session.header.actions` 槽位）
- 依赖 `dsh-our-free-model` 的 `accountPool` 服务与 `/api/channel-pack` 的 `credits.balances` 方法。这些是它的内部结构，非公开 API；对方改名后插件会记日志并回退到静态表，不会崩溃。

## 备注

插件只读取积分，不写入任何其它插件的数据文件，也不修改 OFM 的任何状态。

## License

MIT
